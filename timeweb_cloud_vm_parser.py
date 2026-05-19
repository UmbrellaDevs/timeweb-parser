#!/usr/bin/env python3
"""
Скрипт для автоматического создания VM в Timeweb Cloud
и поиска IP-адресов, начинающихся с заданного префикса (по умолчанию 185.39)
"""
import sys
import io
if sys.platform == 'win32':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

import time
import json
import os
import platform
from typing import List, Optional, Dict
from pathlib import Path
import re
from datetime import datetime
import subprocess
import secrets
import string

# TLS fingerprint Chrome — curl_cffi с fallback на requests
_socks_proxy = os.environ.get('SOCKS5_PROXY', '').strip()
_proxy_dict = None
if _socks_proxy:
    _proxy_url = f'socks5h://{_socks_proxy}'
    _proxy_dict = {"http": _proxy_url, "https": _proxy_url}
    os.environ['ALL_PROXY'] = _proxy_url
    os.environ['HTTP_PROXY'] = _proxy_url
    os.environ['HTTPS_PROXY'] = _proxy_url
    print(f'[PROXY] Используется SOCKS5 прокси: {_socks_proxy.split("@")[-1]}')

try:
    from curl_cffi import requests
    _USE_CURL_CFFI = True
    print('[TLS] curl_cffi — fingerprint Chrome')
except ImportError:
    import requests
    _USE_CURL_CFFI = False
    print('[TLS] requests — стандартный fingerprint')


def _req_get(url, **kwargs):
    if _USE_CURL_CFFI:
        kwargs.setdefault('impersonate', 'chrome131')
        if _proxy_dict:
            kwargs.setdefault('proxies', _proxy_dict)
    return requests.get(url, **kwargs)


def _req_post(url, **kwargs):
    if _USE_CURL_CFFI:
        kwargs.setdefault('impersonate', 'chrome131')
        if _proxy_dict:
            kwargs.setdefault('proxies', _proxy_dict)
    return requests.post(url, **kwargs)


def _req_delete(url, **kwargs):
    if _USE_CURL_CFFI:
        kwargs.setdefault('impersonate', 'chrome131')
        if _proxy_dict:
            kwargs.setdefault('proxies', _proxy_dict)
    return requests.delete(url, **kwargs)

try:
    import paramiko
except ImportError:
    paramiko = None

try:
    import socks as _socks_module
except ImportError:
    _socks_module = None


def _make_proxy_sock(host: str, port: int):
    """Создаёт SOCKS5-сокет через прокси аккаунта для SSH-соединений."""
    proxy_str = os.environ.get('SOCKS5_PROXY', '').strip()
    if not proxy_str or not _socks_module:
        return None
    try:
        auth_part, addr_part = proxy_str.rsplit('@', 1) if '@' in proxy_str else ('', proxy_str)
        proxy_host, proxy_port = addr_part.split(':')
        proxy_user = proxy_pass = None
        if auth_part and ':' in auth_part:
            proxy_user, proxy_pass = auth_part.split(':', 1)
        sock = _socks_module.create_connection(
            (host, port),
            proxy_type=_socks_module.SOCKS5,
            proxy_addr=proxy_host,
            proxy_port=int(proxy_port),
            proxy_username=proxy_user,
            proxy_password=proxy_pass,
            timeout=15,
        )
        return sock
    except Exception as e:
        print(f"  [PROXY-SSH] Не удалось создать SOCKS-сокет: {e}")
        return None


class TimewebCloudVM:
    def __init__(self, api_token: str, zone: str = "ru-1",
                 os_id: int = 79, preset_id: int = 4795,
                 enable_logging: bool = True):
        """
        Инициализация клиента Timeweb Cloud

        Args:
            api_token: API токен Timeweb Cloud (Bearer)
            zone: Зона доступности (ru-1, ru-2, ru-3)
            os_id: ID операционной системы (по умолчанию 79)
            preset_id: ID пресета сервера (по умолчанию 4795)
        """
        self.api_token = api_token
        self.zone = zone
        self.os_id = os_id
        self.preset_id = preset_id
        self.base_url = "https://api.timeweb.cloud/api/v1"
        self.headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
            "Accept-Encoding": "gzip, deflate, br",
        }
        self.created_instances = []  # Список созданных серверов для очистки
        self.enable_logging = True
        self.log_file = None
        if self.enable_logging:
            log_dir = Path(__file__).parent / "logs"
            log_dir.mkdir(exist_ok=True)
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.log_file = log_dir / f"ip_check_{timestamp}.log"
            self._log(f"=== Начало сессии логирования ===")
            self._log(f"Зона: {zone}")

    def _log(self, message: str, level: str = "INFO"):
        """Логирует сообщение в файл и консоль"""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        log_message = f"[{timestamp}] [{level}] {message}"

        if self.enable_logging and self.log_file:
            try:
                with open(self.log_file, 'a', encoding='utf-8') as f:
                    f.write(log_message + '\n')
            except Exception:
                pass

        if level in ["ERROR", "WARNING", "INFO"]:
            print(log_message)

    def create_vm(self, name: str) -> Optional[int]:
        """
        Создает виртуальную машину в Timeweb Cloud

        Args:
            name: Имя виртуальной машины

        Returns:
            ID созданного сервера или None при ошибке
        """
        url = f"{self.base_url}/servers"

        payload = {
            "name": name,
            "os_id": self.os_id,
            "preset_id": self.preset_id,
            "bandwidth": 200,
            "is_ddos_guard": False,
            "availability_zone": self.zone
        }

        try:
            self._log(f"Создание VM '{name}' в зоне {self.zone}...", "INFO")
            response = _req_post(url, headers=self.headers, json=payload, timeout=30)

            if response.status_code == 400:
                error_data = {}
                try:
                    error_data = response.json()
                except Exception:
                    pass
                error_msg = error_data.get("message", response.text[:200])
                self._log(f"Ошибка 400 при создании VM '{name}': {error_msg}", "ERROR")
                print(f"  Детали: {error_msg}")
                return None

            if response.status_code == 429:
                self._log(f"Rate limit при создании VM '{name}' — слишком много запросов", "WARNING")
                return None

            response.raise_for_status()
            result = response.json()
            server_data = result.get("server", {})
            server_id = server_data.get("id")

            if server_id:
                self._log(f"VM '{name}' создана (ID: {server_id}, статус: {server_data.get('status', '?')})", "INFO")
                self.created_instances.append(server_id)
                print(f"  VM создана: {name} (ID: {server_id})")
                return server_id
            else:
                self._log(f"VM '{name}' создана, но ID не получен", "WARNING")
                print(f"  Ошибка: VM {name} создана, но ID не получен")
                return None

        except requests.exceptions.HTTPError as e:
            error_status = e.response.status_code if hasattr(e, 'response') and e.response is not None else 'N/A'
            error_detail = ''
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_detail = e.response.json().get("message", e.response.text[:200])
                except Exception:
                    error_detail = e.response.text[:200] if hasattr(e.response, 'text') else ''
            self._log(f"HTTPError при создании VM '{name}': {error_status} — {error_detail}", "ERROR")
            print(f"  Ошибка при создании VM {name}: HTTP {error_status}")
            if error_detail:
                print(f"  Детали: {error_detail}")
            return None
        except requests.exceptions.RequestException as e:
            self._log(f"RequestException при создании VM '{name}': {e}", "ERROR")
            print(f"  Ошибка сети при создании VM {name}: {e}")
            return None
        except Exception as e:
            self._log(f"Exception при создании VM '{name}': {e}", "ERROR")
            print(f"  Неожиданная ошибка при создании VM {name}: {e}")
            return None

    def wait_for_vm_ready(self, server_id: int, timeout: int = 300) -> bool:
        """
        Ожидает готовности сервера (статус "on")

        Args:
            server_id: ID сервера
            timeout: Максимальное время ожидания в секундах

        Returns:
            True если сервер готов, False при таймауте
        """
        start_time = time.time()
        time.sleep(5)  # Небольшая задержка перед первой проверкой

        while time.time() - start_time < timeout:
            try:
                url = f"{self.base_url}/servers/{server_id}"
                response = _req_get(url, headers=self.headers, timeout=10)

                if response.status_code == 200:
                    server_data = response.json().get("server", {})
                    status = server_data.get("status", "")

                    if status == "on":
                        print(f"  VM {server_id} запущена")
                        return True
                    elif status in ["installing", "starting"]:
                        elapsed = int(time.time() - start_time)
                        if elapsed % 10 == 0:
                            print(f"  VM {server_id} создается... (статус: {status}, прошло {elapsed} сек)")
                        time.sleep(5)
                        continue
                    elif status in ["off", "error"]:
                        self._log(f"VM {server_id} в состоянии {status}", "ERROR")
                        return False
                    else:
                        time.sleep(5)
                        continue
                elif response.status_code == 404:
                    elapsed = int(time.time() - start_time)
                    if elapsed < 60:
                        time.sleep(5)
                        continue
                    else:
                        self._log(f"VM {server_id} не найден после {elapsed} сек", "ERROR")
                        return False
                else:
                    time.sleep(5)
                    continue
            except requests.exceptions.RequestException:
                time.sleep(5)
                continue

        self._log(f"Таймаут ожидания готовности VM {server_id}", "WARNING")
        return False

    def get_vm_ip(self, server_id: int) -> Optional[str]:
        """
        Получает внешний IP-адрес сервера

        Args:
            server_id: ID сервера

        Returns:
            IP-адрес или None
        """
        url = f"{self.base_url}/servers/{server_id}"
        self._log(f"Запрос IP для VM {server_id}", "DEBUG")

        try:
            response = _req_get(url, headers=self.headers, timeout=10)

            if response.status_code != 200:
                self._log(f"VM {server_id}: HTTP {response.status_code}", "ERROR")
                return None

            server_data = response.json().get("server", {})

            # Способ 1: main_ipv4
            ip = server_data.get("main_ipv4")
            if ip and self._is_ip_address(ip):
                self._log(f"VM {server_id}: IP из main_ipv4: {ip}", "DEBUG")
                return ip

            # Способ 2: networks[].ips[].ip
            networks = server_data.get("networks", [])
            for net in networks:
                ips = net.get("ips", [])
                for ip_info in ips:
                    ip = ip_info.get("ip")
                    if ip and self._is_ip_address(ip):
                        self._log(f"VM {server_id}: IP из networks: {ip}", "DEBUG")
                        return ip

            self._log(f"VM {server_id}: IP не найден в ответе", "DEBUG")
            return None

        except requests.exceptions.RequestException as e:
            self._log(f"VM {server_id}: ошибка запроса: {e}", "ERROR")
            return None
        except Exception as e:
            self._log(f"VM {server_id}: неожиданная ошибка: {e}", "ERROR")
            return None

    def _is_ip_address(self, value: str) -> bool:
        """Проверяет, является ли строка IPv4-адресом"""
        if not isinstance(value, str):
            return False
        ip_pattern = r'^(\d{1,3}\.){3}\d{1,3}$'
        if not re.match(ip_pattern, value):
            return False
        parts = value.split('.')
        try:
            return all(0 <= int(part) <= 255 for part in parts)
        except ValueError:
            return False

    def delete_vm(self, server_id: int, silent: bool = False) -> bool:
        """
        Удаляет сервер

        Args:
            server_id: ID сервера
            silent: Если True, не выводит сообщения

        Returns:
            True если удаление успешно
        """
        url = f"{self.base_url}/servers/{server_id}"

        for attempt in range(4):
            try:
                response = _req_delete(url, headers=self.headers, timeout=10)

                if response.status_code == 204 or response.status_code == 200:
                    if not silent:
                        print(f"  VM {server_id} удалена")
                    return True
                elif response.status_code == 404:
                    return True  # Уже удалена
                elif response.status_code == 429:
                    wait = 5 * (attempt + 1)
                    if not silent:
                        self._log(f"VM {server_id}: 429, повтор через {wait}с (попытка {attempt+1}/4)", "WARNING")
                    time.sleep(wait)
                    continue
                else:
                    response.raise_for_status()

            except requests.exceptions.HTTPError as e:
                if hasattr(e, 'response') and e.response is not None:
                    if e.response.status_code == 404:
                        return True
                    if e.response.status_code == 429:
                        wait = 5 * (attempt + 1)
                        time.sleep(wait)
                        continue
                if not silent:
                    print(f"  Ошибка при удалении VM {server_id}: {e}")
                return False
            except requests.exceptions.RequestException:
                return True  # Считаем успешным при сетевой ошибке

        if not silent:
            print(f"  VM {server_id}: не удалось удалить после 4 попыток")
        return False

    def list_existing_vms(self, silent: bool = False) -> List[int]:
        """
        Получает список всех существующих серверов

        Returns:
            Список ID существующих серверов
        """
        url = f"{self.base_url}/servers"

        try:
            response = _req_get(url, headers=self.headers, timeout=10)
            response.raise_for_status()
            servers = response.json().get("servers", [])
            server_ids = [srv.get("id") for srv in servers if srv.get("id")]
            if not silent:
                if server_ids:
                    print(f"Найдено {len(server_ids)} существующих VM")
                else:
                    print("Существующих VM не найдено")
            return server_ids
        except requests.exceptions.RequestException as e:
            if not silent:
                print(f"  Ошибка при получении списка VM: {e}")
            return []

    def cleanup_existing_vms(self, exclude_ids: List[int] = None) -> int:
        """
        Удаляет все существующие VM (кроме исключенных)

        Returns:
            Количество удаленных VM
        """
        exclude_ids = exclude_ids or []
        existing_vms = self.list_existing_vms()

        if not existing_vms:
            return 0

        vms_to_delete = [vm_id for vm_id in existing_vms if vm_id not in exclude_ids]

        if not vms_to_delete:
            return 0

        print(f"\nНайдено {len(existing_vms)} существующих VM")
        print(f"Удаление {len(vms_to_delete)} VM для освобождения квот...")

        deleted_count = 0
        for vm_id in vms_to_delete:
            if self.delete_vm(vm_id):
                deleted_count += 1
            time.sleep(3 + secrets.randbelow(3))

        if deleted_count > 0:
            print(f"  Удалено {deleted_count} VM")
            time.sleep(5)

        return deleted_count

    def check_ip_prefix(self, ip: str, prefix: str = "185.39") -> bool:
        """
        Проверяет, начинается ли IP-адрес с одного из указанных префиксов.
        Поддерживает несколько префиксов через запятую: "185.39, 92.38"
        """
        if not ip:
            return False
        prefixes = [p.strip() for p in prefix.split(',') if p.strip()]
        return any(ip.startswith(p) for p in prefixes)

    def create_and_check_vms(self, count: int = 7, target_ip_prefix: str = "185.39",
                              protected_vm_ids: set = None) -> Optional[Dict]:
        """
        Создает указанное количество VM, проверяет IP у всех, удаляет все если не найдено

        Args:
            count: Количество VM для создания за раз
            target_ip_prefix: Искомый префикс IP
            protected_vm_ids: Множество ID VM, которые нельзя удалять

        Returns:
            Словарь с информацией о найденной VM или None
        """
        if protected_vm_ids is None:
            protected_vm_ids = set()

        print(f"\n{'='*60}")
        print(f"Создание {count} VM в зоне {self.zone}")
        print(f"Поиск IP с префиксом: {target_ip_prefix}")
        print(f"{'='*60}\n")

        # Создаем все VM
        server_ids = []
        for i in range(count):
            vm_name = f"parser-{secrets.token_hex(6)}"
            server_id = self.create_vm(vm_name)
            if server_id:
                server_ids.append(server_id)
            time.sleep(3 + secrets.randbelow(3))

        if not server_ids:
            print("  Не удалось создать ни одной VM")
            return None

        print(f"\nСоздано {len(server_ids)} VM. Ожидание готовности и проверка IP...")
        self._log(f"Начало проверки IP для {len(server_ids)} VM", "INFO")

        # Ждём пока все VM станут готовы и получим их IP
        all_vm_ips = {}
        max_checks = 30  # Проверяем до 30 раз (по 5 сек = 2.5 мин)

        for check_num in range(max_checks):
            self._log(f"=== Попытка #{check_num + 1}/{max_checks} получения IP ===", "DEBUG")

            try:
                url = f"{self.base_url}/servers"
                response = _req_get(url, headers=self.headers, timeout=10)

                if response.status_code == 200:
                    servers = response.json().get("servers", [])

                    for srv in servers:
                        srv_id = srv.get("id")
                        if srv_id in all_vm_ips:
                            continue

                        status = srv.get("status", "")

                        # Получаем IP
                        ip = srv.get("main_ipv4")
                        if not ip or not self._is_ip_address(ip):
                            # Пробуем из networks
                            networks = srv.get("networks", [])
                            for net in networks:
                                for ip_info in net.get("ips", []):
                                    candidate = ip_info.get("ip")
                                    if candidate and self._is_ip_address(candidate):
                                        ip = candidate
                                        break
                                if ip and self._is_ip_address(ip):
                                    break

                        if ip and self._is_ip_address(ip) and status == "on":
                            all_vm_ips[srv_id] = ip
                            srv_name = srv.get("name", "N/A")
                            self._log(f"VM {srv_id} ({srv_name}): найден IP {ip}", "INFO")
                            print(f"    VM {srv_name[:30]:30} (ID {srv_id}): {ip}")

                    # Проверяем, все ли наши VM получили IP
                    our_vms_with_ip = [sid for sid in server_ids if sid in all_vm_ips]
                    if len(our_vms_with_ip) >= len(server_ids):
                        self._log(f"Получены IP у всех {len(our_vms_with_ip)} созданных VM", "INFO")
                        break

                    if check_num % 5 == 0:
                        print(f"  Попытка {check_num + 1}: найдено IP {len(our_vms_with_ip)}/{len(server_ids)}")
                else:
                    self._log(f"Ошибка получения списка VM: HTTP {response.status_code}", "ERROR")
            except Exception as e:
                self._log(f"Ошибка при получении списка VM: {e}", "ERROR")

            if check_num < max_checks - 1:
                time.sleep(5)

        # Проверяем все собранные IP на наличие нужного префикса
        print(f"\n{'='*60}")
        print(f"Собрано IP адресов: {len(all_vm_ips)}")
        if protected_vm_ids:
            protected_count = len([vid for vid in all_vm_ips.keys() if vid in protected_vm_ids])
            print(f"  (из них защищенных: {protected_count})")
        print(f"{'='*60}")

        if all_vm_ips:
            print(f"\nВсе найденные IP адреса:")
            for sid, ip in all_vm_ips.items():
                protected_mark = " [ЗАЩИЩЕНА]" if sid in protected_vm_ids else ""
                print(f"  VM {sid}: {ip}{protected_mark}")
        else:
            print(f"\n  IP адреса не найдены ни у одной VM")

        # Ищем IP с нужным префиксом (пропускаем защищенные)
        found_vm = None
        for sid, ip in all_vm_ips.items():
            if sid in protected_vm_ids:
                self._log(f"Пропускаем защищенную VM {sid} с IP {ip}", "DEBUG")
                continue

            if self.check_ip_prefix(ip, target_ip_prefix):
                self._log(f"НАЙДЕН ЦЕЛЕВОЙ IP! VM {sid}: {ip} (префикс {target_ip_prefix})", "INFO")
                print(f"\n{'='*60}")
                print(f"  НАЙДЕН IP С ПРЕФИКСОМ {target_ip_prefix}!")
                print(f"  VM ID: {sid}")
                print(f"  IP: {ip}")
                print(f"{'='*60}")
                found_vm = {
                    "instance_id": str(sid),
                    "ip": ip,
                    "zone": self.zone,
                }
                break

        if found_vm:
            # Удаляем все VM кроме найденной и защищенных
            found_id = int(found_vm['instance_id'])
            vms_to_delete = [vid for vid in all_vm_ips.keys()
                            if vid != found_id and vid not in protected_vm_ids]
            if vms_to_delete:
                print(f"Удаление остальных {len(vms_to_delete)} VM...")
                for vid in vms_to_delete:
                    self.delete_vm(vid, silent=True)
                    if vid in self.created_instances:
                        self.created_instances.remove(vid)
                print(f"  Удалено {len(vms_to_delete)} VM. Найденная VM сохранена.")

            if found_id in self.created_instances:
                self.created_instances.remove(found_id)

            return found_vm

        # Не нашли нужный IP — удаляем все VM (кроме защищенных)
        print(f"\n  IP с префиксом {target_ip_prefix} не найден среди {len(all_vm_ips)} VM")
        _del_pause = secrets.randbelow(3) + 3
        print(f"  Пауза {_del_pause} сек перед удалением...")
        time.sleep(_del_pause)
        print(f"Удаление всех VM (кроме защищенных)...")

        existing_vms = self.list_existing_vms(silent=True)
        if existing_vms:
            vms_to_delete = [vid for vid in existing_vms if vid not in protected_vm_ids]
            if vms_to_delete:
                print(f"Найдено {len(vms_to_delete)} VM для удаления (защищено: {len(protected_vm_ids)})")
                deleted_count = 0
                for vid in vms_to_delete:
                    if self.delete_vm(vid, silent=True):
                        deleted_count += 1
                    time.sleep(3 + secrets.randbelow(3))
                if deleted_count > 0:
                    print(f"  Отправлено на удаление {deleted_count} VM")

        self.created_instances.clear()
        return None

    def cleanup_all_vms(self):
        """Удаляет все созданные VM"""
        if not self.created_instances:
            return

        print(f"\nОчистка: удаление {len(self.created_instances)} VM...")
        instances_to_delete = self.created_instances[:]
        self.created_instances.clear()

        for sid in instances_to_delete:
            try:
                self.delete_vm(sid)
            except KeyboardInterrupt:
                print(f"\n  Прервано при удалении VM {sid}")
                raise
            except Exception as e:
                print(f"  Ошибка при удалении VM {sid}: {e}")

    def wait_for_all_vms_deleted(self, timeout: int = 120, protected_vm_ids: set = None) -> bool:
        """
        Ждет пока все незащищенные VM не будут удалены
        """
        if protected_vm_ids is None:
            protected_vm_ids = set()

        start_time = time.time()
        check_interval = 5

        print(f"\nОжидание удаления всех незащищенных VM...")

        while time.time() - start_time < timeout:
            existing_vms = self.list_existing_vms(silent=True)
            unprotected_vms = [vid for vid in existing_vms if vid not in protected_vm_ids]

            if not unprotected_vms:
                print(f"  Все незащищенные VM удалены")
                return True

            elapsed = int(time.time() - start_time)

            # Принудительно удаляем после 60 сек
            if elapsed > 60 and unprotected_vms:
                print(f"  Прошло {elapsed} сек, осталось {len(unprotected_vms)} VM — принудительное удаление...")
                for vid in unprotected_vms:
                    self.delete_vm(vid, silent=True)
                time.sleep(3)
                continue

            print(f"  Ожидание... ({len(unprotected_vms)} VM осталось, прошло {elapsed} сек)")
            time.sleep(check_interval)

        # Таймаут — принудительное удаление
        remaining = self.list_existing_vms(silent=True)
        unprotected_remaining = [vid for vid in remaining if vid not in protected_vm_ids]
        if unprotected_remaining:
            print(f"\n  Таймаут, принудительное удаление {len(unprotected_remaining)} VM...")
            for vid in unprotected_remaining:
                self.delete_vm(vid, silent=True)
            return False
        return True

    def check_existing_vms_for_target_ip(self, target_ip_prefix: str = "185.39") -> Optional[Dict]:
        """
        Проверяет существующие VM на наличие IP с нужным префиксом
        """
        self._log(f"Проверка существующих VM на наличие IP с префиксом {target_ip_prefix}...", "INFO")
        print(f"\n{'='*60}")
        print(f"Проверка существующих VM на IP с префиксом {target_ip_prefix}...")
        print(f"{'='*60}")

        try:
            url = f"{self.base_url}/servers"
            response = _req_get(url, headers=self.headers, timeout=10)

            if response.status_code != 200:
                print(f"  Не удалось получить список VM (HTTP {response.status_code})")
                return None

            servers = response.json().get("servers", [])

            if not servers:
                print("  Существующих VM не найдено")
                return None

            print(f"  Найдено {len(servers)} существующих VM, проверяем их IP...")

            for srv in servers:
                srv_id = srv.get("id")
                srv_name = srv.get("name", "N/A")

                # Получаем IP
                ip = srv.get("main_ipv4")
                if not ip or not self._is_ip_address(ip):
                    networks = srv.get("networks", [])
                    for net in networks:
                        for ip_info in net.get("ips", []):
                            candidate = ip_info.get("ip")
                            if candidate and self._is_ip_address(candidate):
                                ip = candidate
                                break
                        if ip and self._is_ip_address(ip):
                            break

                if ip and self._is_ip_address(ip):
                    if self.check_ip_prefix(ip, target_ip_prefix):
                        self._log(f"НАЙДЕНА СУЩЕСТВУЮЩАЯ VM С IP {target_ip_prefix}*! VM {srv_id}: {ip}", "INFO")
                        print(f"\n{'='*60}")
                        print(f"  НАЙДЕНА СУЩЕСТВУЮЩАЯ VM С IP {target_ip_prefix}*!")
                        print(f"  VM ID: {srv_id}")
                        print(f"  Имя: {srv_name}")
                        print(f"  IP: {ip}")
                        print(f"\n  Эта VM НЕ будет удалена, продолжаем поиск новой VM...")
                        print(f"{'='*60}\n")
                        return {
                            "instance_id": str(srv_id),
                            "ip": ip,
                            "zone": self.zone,
                            "name": srv_name,
                            "existing": True
                        }
                    else:
                        print(f"  VM {srv_name[:30]:30} (ID {srv_id}): {ip} (не подходит)")

            print(f"\n  Среди {len(servers)} существующих VM нет IP с префиксом {target_ip_prefix}")
            return None

        except Exception as e:
            self._log(f"Ошибка при проверке существующих VM: {e}", "ERROR")
            print(f"  Ошибка при проверке существующих VM: {e}")
            return None

    def search_target_ip(self, target_ip_prefix: str = "185.39",
                         batch_size: int = 7, zones: list = None, telegram_config: Dict = None,
                         account_info: Dict = None) -> Optional[Dict]:
        """
        Основная функция: создает VM по кругу пока не найдет IP с нужным префиксом
        """
        protected_vm_ids = set()

        existing_vm_with_target_ip = self.check_existing_vms_for_target_ip(target_ip_prefix)
        if existing_vm_with_target_ip:
            protected_vm_id = int(existing_vm_with_target_ip['instance_id'])
            protected_vm_ids.add(protected_vm_id)
            self._log(f"VM {protected_vm_id} добавлена в защищенный список", "INFO")

        # Добавляем все существующие VM с нужным IP в защищенный список
        try:
            url = f"{self.base_url}/servers"
            response = _req_get(url, headers=self.headers, timeout=10)
            if response.status_code == 200:
                servers = response.json().get("servers", [])
                for srv in servers:
                    srv_id = srv.get("id")
                    ip = srv.get("main_ipv4")
                    if not ip or not self._is_ip_address(ip):
                        for net in srv.get("networks", []):
                            for ip_info in net.get("ips", []):
                                candidate = ip_info.get("ip")
                                if candidate and self._is_ip_address(candidate):
                                    ip = candidate
                                    break
                            if ip and self._is_ip_address(ip):
                                break
                    if ip and self._is_ip_address(ip) and self.check_ip_prefix(ip, target_ip_prefix):
                        protected_vm_ids.add(srv_id)
        except Exception:
            pass

        if protected_vm_ids:
            print(f"\n  Защищено от удаления {len(protected_vm_ids)} VM с IP {target_ip_prefix}*")

        if zones is None:
            zones = [self.zone]

        iteration = 1
        zone_index = 0

        try:
            while True:
                current_zone = zones[zone_index % len(zones)]
                original_zone = self.zone
                self.zone = current_zone

                print(f"\n{'#'*60}")
                print(f"Итерация #{iteration} | Зона: {current_zone}")
                print(f"{'#'*60}")

                try:
                    _rand_batch = secrets.choice([5, 6, 7])
                    found_vm = self.create_and_check_vms(
                        count=_rand_batch,
                        target_ip_prefix=target_ip_prefix,
                        protected_vm_ids=protected_vm_ids
                    )

                    if found_vm:
                        _ai = account_info or {}
                        found_vm['zone'] = current_zone
                        found_vm['account_name'] = _ai.get('account_name', '')
                        found_vm['account_proxy'] = _ai.get('account_proxy', '')
                        found_vm['account_id'] = _ai.get('account_id', '')

                        self._log(f"НАЙДЕН ЦЕЛЕВОЙ IP в зоне {current_zone}!", "INFO")
                        print(f"\n  НАЙДЕН IP С ПРЕФИКСОМ {target_ip_prefix} В ЗОНЕ {current_zone}!")

                        # SSH настройка — подключаемся и ставим пароль root
                        try:
                            print("Ожидание готовности SSH на VM (до 2 мин)...")
                            if wait_for_ssh_password(found_vm['ip'], port=22, timeout=120):
                                print("SSH доступен, настройка входа по паролю...")
                                root_pass = setup_root_password_timeweb(found_vm['ip'], port=22)
                                if root_pass:
                                    found_vm['root_login'] = 'root'
                                    found_vm['root_password'] = root_pass
                                    found_vm['ssh_port'] = 22
                                else:
                                    print("  Вход по паролю не настроен (Timeweb генерирует пароль сам)")
                            else:
                                print("  SSH не ответил за 2 мин")
                        except Exception as _ssh_e:
                            print(f"  Ошибка при настройке SSH: {_ssh_e}")

                        # Уведомление
                        try:
                            send_notification(found_vm, telegram_config)
                        except Exception as _notif_e:
                            print(f"  Ошибка отправки уведомления: {_notif_e}")

                        # Лог найденных серверов
                        try:
                            _log_path = Path(__file__).parent / "found_servers.log"
                            _ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                            _lines = [
                                f"{'='*60}",
                                f"[{_ts}] НАЙДЕН СЕРВЕР",
                                f"  Аккаунт : {found_vm.get('account_name', '?')}",
                                f"  Прокси  : {found_vm.get('account_proxy', '--')}",
                                f"  VM ID   : {found_vm.get('instance_id', '?')}",
                                f"  IP      : {found_vm.get('ip', '?')}",
                                f"  Зона    : {found_vm.get('zone', '?')}",
                                f"  Логин   : {found_vm.get('root_login', '?')}",
                                f"  Пароль  : {found_vm.get('root_password', '--')}",
                                "",
                            ]
                            with open(_log_path, "a", encoding="utf-8") as _lf:
                                _lf.write("\n".join(_lines) + "\n")
                        except Exception:
                            pass

                        # Удаляем остальные VM
                        try:
                            instances_to_remove = [inst_id for inst_id in self.created_instances
                                                 if str(inst_id) != found_vm['instance_id']]
                            if instances_to_remove:
                                print(f"Удаление {len(instances_to_remove)} остальных VM...")
                                for inst_id in instances_to_remove:
                                    self.delete_vm(inst_id, silent=True)
                                    if inst_id in self.created_instances:
                                        self.created_instances.remove(inst_id)
                        except Exception:
                            pass

                        print(f"\n{'='*60}")
                        print(f"  СКРИПТ ЗАВЕРШЕН УСПЕШНО!")
                        print(f"  Зона: {current_zone}")
                        print(f"  VM ID: {found_vm['instance_id']}")
                        print(f"  IP: {found_vm['ip']}")
                        print(f"{'='*60}\n")

                        return found_vm

                    # Не нашли — ждём удаления и переходим на следующую зону
                    print(f"\nIP с префиксом {target_ip_prefix} не найден в зоне {current_zone}.")
                    if not self.wait_for_all_vms_deleted(protected_vm_ids=protected_vm_ids):
                        print("  Не все VM удалены, но продолжаем...")

                    zone_index += 1
                    iteration += 1
                    _pause = secrets.randbelow(3) + 3
                    print(f"  Пауза {_pause} сек перед следующей итерацией...")
                    time.sleep(_pause)

                except KeyboardInterrupt:
                    raise
                except Exception as e:
                    print(f"\n  Ошибка в итерации #{iteration} (зона {current_zone}): {e}")
                    self._log(f"Ошибка в зоне {current_zone}: {e}", "ERROR")
                    self.cleanup_all_vms()
                    zone_index += 1
                    iteration += 1
                    time.sleep(5)

        except KeyboardInterrupt:
            print("\n\n  Прервано пользователем. Очистка...")
            try:
                self.cleanup_all_vms()
            except KeyboardInterrupt:
                print("\n  Прервано повторно. Выход...")
            except Exception as e:
                print(f"\n  Ошибка при очистке: {e}")
            return None


def wait_for_ssh_password(host: str, port: int = 22, timeout: int = 120) -> bool:
    """
    Ожидает доступности SSH на хосте.
    Timeweb Cloud устанавливает пароль root при создании — мы просто ждём, что SSH поднимется.
    """
    import logging
    _paramiko_log = logging.getLogger("paramiko")
    _old_level = _paramiko_log.level
    _paramiko_log.setLevel(logging.CRITICAL)
    try:
        time.sleep(15)
        start = time.time()
        while time.time() - start < timeout:
            import socket
            try:
                sock = _make_proxy_sock(host, port) if _socks_proxy else None
                if sock is None:
                    sock = socket.create_connection((host, port), timeout=10)
                banner = sock.recv(256)
                sock.close()
                if b'SSH' in banner:
                    return True
            except Exception:
                pass
            time.sleep(5)
        return False
    finally:
        _paramiko_log.setLevel(_old_level)


def setup_root_password_timeweb(host: str, port: int = 22) -> Optional[str]:
    """
    Timeweb Cloud присылает root-пароль при создании сервера.
    Так как мы не можем получить его через API напрямую,
    мы генерируем свой пароль и пытаемся подключиться по ключу, чтобы его установить.
    Если ключа нет — пробуем использовать сгенерированный пароль Timeweb.

    В большинстве случаев Timeweb отправляет пароль на email.
    Здесь мы просто возвращаем None, а пароль будет получен иначе.
    """
    # Timeweb Cloud генерирует пароль root автоматически и присылает на email.
    # Через API мы не получаем этот пароль, поэтому возвращаем None.
    # Пользователь может использовать SSH ключ или пароль из email.
    return None


def _build_telegram_message(vm_info: Dict) -> str:
    """Формирует текст сообщения для Telegram."""
    ip = vm_info.get("ip", "N/A")
    ssh_port = vm_info.get("ssh_port", 22)
    root_login = vm_info.get("root_login", "")
    root_password = vm_info.get("root_password", "")
    account_name = vm_info.get("account_name", "")
    account_proxy = vm_info.get("account_proxy", "")
    account_id = vm_info.get("account_id", "")

    header = ""
    if account_name:
        label = f"#{account_id} " if account_id != "" else ""
        header += f"<b>Аккаунт:</b> {label}<code>{account_name}</code>\n"
    if account_proxy:
        header += f"<b>Прокси:</b> <code>{account_proxy}</code>\n"
    if header:
        header += "\n"

    message = (
        header +
        f"<b>IP:</b> <code>{ip}</code>\n"
        f"<b>Порт:</b> <code>{ssh_port}</code>\n\n"
    )
    if root_login and root_password:
        message += (
            "<b>Вход по паролю:</b>\n"
            f"  Хост: <code>{ip}</code>\n"
            f"  Логин: <code>{root_login}</code>\n"
            f"  Пароль: <code>{root_password}</code>\n\n"
            f"Подключение: <code>ssh {root_login}@{ip}</code>"
        )
    return message


def _try_send_telegram(bot_token: str, chat_id: str, message: str, proxy: str = None, label: str = "") -> bool:
    """Одна попытка отправки в Telegram."""
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {"chat_id": chat_id, "text": message, "parse_mode": "HTML"}

    if proxy:
        proxy_url = f"socks5h://{proxy}" if "://" not in proxy else proxy
        proxies = {"http": proxy_url, "https": proxy_url}
    else:
        proxies = {"http": "", "https": ""}

    try:
        response = _req_post(url, json=payload, timeout=15, proxies=proxies)
        if response.status_code == 200:
            if label:
                print(f"    Отправлено ({label})")
            return True
        else:
            if label:
                print(f"    HTTP {response.status_code} ({label})")
            return False
    except Exception as e:
        if label:
            print(f"    {e} ({label})")
        return False


def send_telegram_notification(vm_info: Dict, bot_token: str, chat_id: str) -> bool:
    """Многоступенчатая отправка в Telegram."""
    if not bot_token or not chat_id:
        return False

    message = _build_telegram_message(vm_info)
    account_proxy = vm_info.get("account_proxy", "")

    if account_proxy:
        print(f"  Попытка 1: через прокси аккаунта...")
        if _try_send_telegram(bot_token, chat_id, message, proxy=account_proxy, label="прокси аккаунта"):
            return True

    print(f"  Попытка 2: напрямую (без прокси)...")
    if _try_send_telegram(bot_token, chat_id, message, proxy=None, label="без прокси"):
        return True

    # Попробовать через другие прокси из БД
    db_path = os.environ.get('TW_DB_PATH', str(Path(__file__).parent / 'launcher' / 'data' / 'launcher.db'))
    if Path(db_path).exists():
        try:
            from db import load_config_from_db
            config = load_config_from_db(db_path)
            other_proxies = []
            for acc in config.get("accounts", []):
                p = acc.get("proxy", "")
                if p and p != account_proxy and p not in other_proxies:
                    other_proxies.append(p)

            for i, proxy in enumerate(other_proxies):
                print(f"  Попытка {3 + i}: через прокси ({proxy.split('@')[-1]})...")
                if _try_send_telegram(bot_token, chat_id, message, proxy=proxy, label=f"прокси #{i+1}"):
                    return True
        except Exception as e:
            print(f"  Не удалось получить другие прокси: {e}")

    print("  Все попытки отправки в Telegram исчерпаны")
    return False


def send_notification(vm_info: Dict, telegram_config: Dict = None):
    """Отправляет уведомление о найденной VM"""
    ip = vm_info.get("ip", "N/A")
    instance_id = vm_info.get("instance_id", "N/A")
    zone = vm_info.get("zone", "N/A")
    is_existing = vm_info.get("existing", False)

    if is_existing:
        print("\n" + "=" * 80)
        print(" " * 15 + "НАЙДЕНА СУЩЕСТВУЮЩАЯ VM С НУЖНЫМ IP!")
        print(" " * 15 + "ПРОДОЛЖАЕМ ПОИСК НОВОЙ VM...")
        print("=" * 80)
        print(f"\n  IP-адрес: {ip}")
        print(f"  VM ID: {instance_id}")
        print(f"  Зона: {zone}")
        print(f"\n  Эта VM защищена от удаления")
        print("=" * 80 + "\n")
    else:
        print("\n" + "!" * 80)
        print(" " * 15 + "НАЙДЕН IP С НУЖНЫМ ПРЕФИКСОМ!")
        print(" " * 15 + "СКРИПТ ОСТАНАВЛИВАЕТСЯ!")
        print("!" * 80)
        print(f"\n  IP-адрес: {ip}")
        print(f"  VM ID: {instance_id}")
        print(f"  Зона: {zone}")
        print("!" * 80 + "\n")

    if not is_existing and platform.system() == "Windows":
        try:
            import winsound
            for _ in range(3):
                winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
                time.sleep(0.3)
        except Exception:
            pass

    if not is_existing:
        db_path = os.environ.get('TW_DB_PATH', str(Path(__file__).parent / 'launcher' / 'data' / 'launcher.db'))

        if Path(db_path).exists():
            try:
                from db import save_found_vm
                if save_found_vm(vm_info, db_path):
                    print(f"  VM сохранена в SQLite БД")
            except Exception as e:
                print(f"  Ошибка сохранения VM в БД: {e}")

        if telegram_config:
            bot_token = telegram_config.get("bot_token")
            chat_id = telegram_config.get("chat_id")
            if bot_token and chat_id:
                print("Отправка уведомления в Telegram...")
                tg_sent = send_telegram_notification(vm_info, bot_token, chat_id)
                if tg_sent:
                    print("  Уведомление отправлено в Telegram")
                    if Path(db_path).exists():
                        try:
                            from db import mark_telegram_sent
                            mark_telegram_sent(vm_info.get("instance_id") or vm_info.get("ip", ""), db_path)
                        except Exception:
                            pass
                else:
                    print("  Не удалось отправить в Telegram")

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        result_file = Path(__file__).parent / f"found_vm_{timestamp}.json"
        try:
            with open(result_file, 'w', encoding='utf-8') as f:
                json.dump(vm_info, f, indent=2, ensure_ascii=False)
            print(f"  Информация сохранена в {result_file}\n")
        except Exception as e:
            print(f"  Ошибка сохранения в файл: {e}\n")

        print_ssh_connection_info(vm_info)


def print_ssh_connection_info(vm_info: Dict):
    """Выводит информацию для SSH подключения."""
    ip = vm_info.get("ip", "N/A")
    zone = vm_info.get("zone", "N/A")
    instance_id = vm_info.get("instance_id", "N/A")
    ssh_port = vm_info.get("ssh_port", 22)
    root_login = vm_info.get("root_login", "")
    root_password = vm_info.get("root_password", "")

    print("\n" + "=" * 80)
    print(" " * 20 + "ИНФОРМАЦИЯ ДЛЯ SSH ПОДКЛЮЧЕНИЯ")
    print("=" * 80)
    print()
    print(f"  IP-адрес:     {ip}")
    print(f"  Порт:         {ssh_port}")
    print(f"  Зона:         {zone}")
    print(f"  VM ID:        {instance_id}")
    if root_login and root_password:
        print()
        print("  Вход по паролю:")
        print(f"     Логин:    {root_login}")
        print(f"     Пароль:   {root_password}")
        print(f"     Команда:  ssh {root_login}@{ip}")
    print()
    print("=" * 80)
    print()


def load_config():
    """Загружает конфигурацию из SQLite БД с fallback на env vars"""
    config = {
        "api_token": None,
        "zone": "ru-1",
        "target_ip_prefix": "185.39",
        "batch_size": 7,
        "os_id": 79,
        "preset_id": 4795,
    }

    config_dir = Path(__file__).parent
    loaded_from_db = False

    # Пытаемся загрузить из SQLite БД
    db_path = os.environ.get('TW_DB_PATH', str(config_dir / 'launcher' / 'data' / 'launcher.db'))
    if Path(db_path).exists():
        try:
            from db import load_config_from_db
            db_config = load_config_from_db(db_path)
            if db_config and (db_config.get('api_token') or db_config.get('accounts')):
                config.update(db_config)
                loaded_from_db = True
                print(f"  Конфигурация загружена из SQLite БД")
        except Exception as e:
            print(f"  Не удалось загрузить из БД: {e}")

    # Мультиаккаунт: если задан TW_ACCOUNT_ID, берём настройки этого аккаунта
    account_id_env = os.getenv("TW_ACCOUNT_ID")
    if account_id_env is not None:
        try:
            acc_id = int(account_id_env)
            accounts = config.get("accounts", [])
            acc = next((a for a in accounts if a.get('id') == acc_id), None)
            if acc:
                print(f"  Аккаунт #{acc_id}: {acc.get('name', '?')}")
                if acc.get("api_token"):
                    config["api_token"] = acc["api_token"]
                config["account_name"] = acc.get("name", "")
                config["account_proxy"] = acc.get("proxy", "")
                config["account_id"] = acc_id
            else:
                print(f"  Аккаунт с ID={acc_id} не найден в БД")
        except ValueError:
            print(f"  Неверное значение TW_ACCOUNT_ID: {account_id_env}")

    # Переменные окружения имеют приоритет
    config["api_token"] = os.getenv("TW_API_TOKEN", config.get("api_token"))
    config["zone"] = os.getenv("TW_ZONE", config.get("zone", "ru-1"))
    config["target_ip_prefix"] = os.getenv("TW_TARGET_IP_PREFIX", config.get("target_ip_prefix", "185.39"))

    batch_size_env = os.getenv("TW_BATCH_SIZE")
    if batch_size_env:
        try:
            config["batch_size"] = int(batch_size_env)
        except ValueError:
            print(f"  Неверное значение TW_BATCH_SIZE: {batch_size_env}")

    os_id_env = os.getenv("TW_OS_ID")
    if os_id_env:
        try:
            config["os_id"] = int(os_id_env)
        except ValueError:
            pass

    preset_id_env = os.getenv("TW_PRESET_ID")
    if preset_id_env:
        try:
            config["preset_id"] = int(preset_id_env)
        except ValueError:
            pass

    return config


def select_zones(zones: list) -> list:
    """Выбор зон для поиска."""
    if os.getenv("TW_NON_INTERACTIVE") or not sys.stdin.isatty():
        print(f"\n  Выбраны все зоны (неинтерактивный режим): {', '.join(zones)}")
        return zones

    print(f"\n{'='*60}")
    print("Выбор зон для поиска IP:")
    print(f"{'='*60}")
    print("\nДоступные зоны:")
    for i, zone in enumerate(zones, 1):
        print(f"  {i}. {zone}")
    print(f"  {len(zones) + 1}. Все зоны (по кругу)")
    print(f"  0. Выход")

    while True:
        try:
            choice = input(f"\nВыберите (1-{len(zones) + 1}, 0=выход): ").strip()
            if choice == "0":
                return None
            choice_num = int(choice)
            if choice_num == len(zones) + 1:
                print(f"\n  Выбраны все зоны: {', '.join(zones)}")
                return zones
            elif 1 <= choice_num <= len(zones):
                selected = zones[choice_num - 1]
                print(f"\n  Выбрана зона: {selected}")
                return [selected]
            else:
                print(f"  Неверный выбор.")
        except ValueError:
            print(f"  Неверный ввод.")
        except EOFError:
            return zones
        except KeyboardInterrupt:
            print("\n\nВыход...")
            return None


def main():
    """Основная функция"""
    config = load_config()

    API_TOKEN = config.get("api_token")
    ZONE = config.get("zone", "ru-1")
    TARGET_IP_PREFIX = config.get("target_ip_prefix", "185.39")
    BATCH_SIZE = config.get("batch_size", 7)
    OS_ID = config.get("os_id", 79)
    PRESET_ID = config.get("preset_id", 4795)

    if not API_TOKEN:
        print("  Ошибка: Необходимо указать API токен Timeweb Cloud")
        print("\nСпособы настройки:")
        print("1. Переменная окружения TW_API_TOKEN")
        print("2. Получите токен: https://timeweb.cloud/my/api-keys")
        return

    # Зоны Timeweb Cloud
    all_zones = ["ru-1", "ru-2", "ru-3"]

    # Если задана конкретная зона через env/config — используем только её
    zone_env = os.getenv("TW_ZONE")
    if zone_env and zone_env in all_zones:
        all_zones = [zone_env]

    zones = select_zones(all_zones)
    if zones is None:
        return

    print(f"\n{'='*60}")
    print("Конфигурация:")
    print(f"  Зоны: {', '.join(zones)}")
    print(f"  Искомый префикс IP: {TARGET_IP_PREFIX}")
    print(f"  Размер батча: {BATCH_SIZE} VM")
    print(f"  OS ID: {OS_ID}")
    print(f"  Preset ID: {PRESET_ID}")
    print(f"{'='*60}\n")

    client = TimewebCloudVM(
        api_token=API_TOKEN,
        zone=zones[0],
        os_id=OS_ID,
        preset_id=PRESET_ID
    )

    # Telegram настройки
    telegram_config = None
    telegram_bot_token = config.get("telegram_bot_token")
    telegram_chat_id = config.get("telegram_chat_id")
    if telegram_bot_token and telegram_chat_id:
        telegram_config = {
            "bot_token": telegram_bot_token,
            "chat_id": telegram_chat_id
        }

    # Проверяем существующие VM
    print("Проверка существующих VM...")
    protected_vm_ids = set()

    existing_vm = client.check_existing_vms_for_target_ip(TARGET_IP_PREFIX)
    if existing_vm:
        protected_vm_ids.add(int(existing_vm['instance_id']))
        print(f"  Найдена существующая VM с IP {existing_vm['ip']}, защищена от удаления")

    # Очищаем существующие VM (кроме защищенных)
    print("\nПроверка существующих VM...")
    deleted = client.cleanup_existing_vms(exclude_ids=list(protected_vm_ids))
    if deleted > 0:
        print(f"  Освобождено место для новых VM")

    if telegram_config:
        print("  Настройки Telegram загружены")
    else:
        print("  Настройки Telegram не указаны")

    # Запуск поиска
    result = client.search_target_ip(
        target_ip_prefix=TARGET_IP_PREFIX,
        batch_size=BATCH_SIZE,
        zones=zones,
        telegram_config=telegram_config,
        account_info=config,
    )

    if result:
        print("\n" + "=" * 60)
        print("  ЗАДАЧА ВЫПОЛНЕНА УСПЕШНО!")
        print("=" * 60)
        print(f"  Зона: {result.get('zone', 'N/A')}")
        print(f"  VM ID: {result.get('instance_id', 'N/A')}")
        print(f"  IP: {result.get('ip', 'N/A')}")
        print("=" * 60)
        print("\nСкрипт завершен. Найденная VM сохранена.\n")
    else:
        print("\n  Поиск прерван")


if __name__ == "__main__":
    main()
