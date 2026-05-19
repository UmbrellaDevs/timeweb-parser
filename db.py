"""
Модуль для работы с SQLite базой данных лаунчера (Timeweb Cloud).
Поддерживает синхронный доступ (sqlite3) и асинхронный (aiosqlite).
"""
import sqlite3
import json
import os
from pathlib import Path
from typing import Optional, Dict, Any, List

DB_PATH = os.environ.get('TW_DB_PATH', str(Path(__file__).parent / 'launcher' / 'data' / 'launcher.db'))


def get_db_path() -> str:
    return os.environ.get('TW_DB_PATH', DB_PATH)



def _get_conn(db_path: Optional[str] = None) -> sqlite3.Connection:
    """Создает соединение с WAL-режимом и busy_timeout."""
    p = db_path or get_db_path()
    conn = sqlite3.connect(p, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def load_config_from_db(db_path: Optional[str] = None) -> Dict[str, Any]:
    """Загружает полный конфиг (config + accounts) из SQLite."""
    conn = _get_conn(db_path)
    try:
        config = {}
        rows = conn.execute("SELECT key, value FROM config").fetchall()
        for row in rows:
            val = row['value']
            if val and val[0] in ('{', '['):
                try:
                    config[row['key']] = json.loads(val)
                except (json.JSONDecodeError, TypeError):
                    config[row['key']] = val
            else:
                try:
                    config[row['key']] = int(val)
                except (ValueError, TypeError):
                    config[row['key']] = val

        acc_rows = conn.execute("SELECT * FROM accounts ORDER BY id").fetchall()
        accounts = []
        for r in acc_rows:
            acc = dict(r)
            acc['active'] = bool(acc.get('active', 1))
            for k in ('created_at', 'updated_at'):
                acc.pop(k, None)
            accounts.append(acc)

        config['accounts'] = accounts
        return config
    finally:
        conn.close()


def get_account_by_id(account_id: int, db_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Получает аккаунт по database ID."""
    conn = _get_conn(db_path)
    try:
        rows = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchall()
        if rows:
            acc = dict(rows[0])
            acc['active'] = bool(acc.get('active', 1))
            return acc
        return None
    finally:
        conn.close()


def save_found_vm(vm_info: Dict[str, Any], db_path: Optional[str] = None) -> bool:
    """Сохраняет найденную VM в БД."""
    conn = _get_conn(db_path)
    try:
        conn.execute("""
            INSERT INTO found_vms (instance_id, ip, zone, username, account_name,
                account_folder_id, account_proxy, private_key_path, public_key_path,
                root_login, root_password, ssh_port)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            vm_info.get('instance_id'),
            vm_info.get('ip'),
            vm_info.get('zone'),
            vm_info.get('username'),
            vm_info.get('account_name'),
            vm_info.get('account_folder_id'),
            vm_info.get('account_proxy'),
            vm_info.get('private_key_path'),
            vm_info.get('public_key_path'),
            vm_info.get('root_login'),
            vm_info.get('root_password'),
            vm_info.get('ssh_port', 22),
        ))
        conn.commit()
        return True
    except Exception as e:
        print(f"[DB] Ошибка сохранения VM: {e}")
        return False
    finally:
        conn.close()


def get_found_vms(db_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Получает список всех найденных VM."""
    conn = _get_conn(db_path)
    try:
        rows = conn.execute("SELECT * FROM found_vms ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def mark_telegram_sent(vm_identifier: str, db_path: Optional[str] = None) -> bool:
    """Помечает VM как отправленную в Telegram. Ищет по instance_id, потом по ip."""
    conn = _get_conn(db_path)
    try:
        cur = conn.execute("UPDATE found_vms SET telegram_sent = 1 WHERE instance_id = ?", (vm_identifier,))
        if cur.rowcount == 0:
            conn.execute("UPDATE found_vms SET telegram_sent = 1 WHERE ip = ?", (vm_identifier,))
        conn.commit()
        return True
    except Exception as e:
        print(f"[DB] mark_telegram_sent error: {e}")
        return False
    finally:
        conn.close()


def get_unsent_vms(db_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Получает VM, для которых не отправлено уведомление в Telegram."""
    conn = _get_conn(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM found_vms WHERE telegram_sent = 0 ORDER BY id DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()



try:
    import aiosqlite

    async def async_get_conn(db_path: Optional[str] = None) -> aiosqlite.Connection:
        """Создает асинхронное соединение."""
        p = db_path or get_db_path()
        conn = await aiosqlite.connect(p, timeout=10)
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA busy_timeout=5000")
        return conn

    async def async_load_config(db_path: Optional[str] = None) -> Dict[str, Any]:
        """Асинхронная загрузка конфига из SQLite."""
        conn = await async_get_conn(db_path)
        try:
            config = {}
            async with conn.execute("SELECT key, value FROM config") as cursor:
                async for row in cursor:
                    val = row['value']
                    if val and val[0] in ('{', '['):
                        try:
                            config[row['key']] = json.loads(val)
                        except (json.JSONDecodeError, TypeError):
                            config[row['key']] = val
                    else:
                        try:
                            config[row['key']] = int(val)
                        except (ValueError, TypeError):
                            config[row['key']] = val

            accounts = []
            async with conn.execute("SELECT * FROM accounts ORDER BY id") as cursor:
                async for r in cursor:
                    acc = dict(r)
                    acc['active'] = bool(acc.get('active', 1))
                    for k in ('created_at', 'updated_at'):
                        acc.pop(k, None)
                    accounts.append(acc)

            config['accounts'] = accounts
            return config
        finally:
            await conn.close()

    async def async_save_found_vm(vm_info: Dict[str, Any], db_path: Optional[str] = None) -> bool:
        """Асинхронное сохранение найденной VM."""
        conn = await async_get_conn(db_path)
        try:
            await conn.execute("""
                INSERT INTO found_vms (instance_id, ip, zone, username, account_name,
                    account_folder_id, account_proxy, private_key_path, public_key_path,
                    root_login, root_password, ssh_port)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                vm_info.get('instance_id'),
                vm_info.get('ip'),
                vm_info.get('zone'),
                vm_info.get('username'),
                vm_info.get('account_name'),
                vm_info.get('account_folder_id'),
                vm_info.get('account_proxy'),
                vm_info.get('private_key_path'),
                vm_info.get('public_key_path'),
                vm_info.get('root_login'),
                vm_info.get('root_password'),
                vm_info.get('ssh_port', 22),
            ))
            await conn.commit()
            return True
        except Exception as e:
            print(f"[DB] Ошибка сохранения VM: {e}")
            return False
        finally:
            await conn.close()

    async def async_get_found_vms(db_path: Optional[str] = None) -> List[Dict[str, Any]]:
        """Асинхронное получение найденных VM."""
        conn = await async_get_conn(db_path)
        try:
            vms = []
            async with conn.execute("SELECT * FROM found_vms ORDER BY id DESC") as cursor:
                async for r in cursor:
                    vms.append(dict(r))
            return vms
        finally:
            await conn.close()

except ImportError:
    pass
