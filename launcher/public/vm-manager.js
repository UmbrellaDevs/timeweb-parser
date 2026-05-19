const VM_API = '/api/vm';

let vmModal, vmList;
let vms = [];
let refreshInterval = null;

function initVMManager() {
  vmModal = document.getElementById('vmModal');
  vmList = document.getElementById('vmList');
  
  if (!vmModal || !vmList) {
    console.error('VM Manager: элементы не найдены');
    return;
  }
  
  const btnVMs = document.getElementById('btnVMs');
  const btnCloseVM = document.getElementById('btnCloseVM');
  
  if (!btnVMs) {
    console.error('VM Manager: кнопка btnVMs не найдена');
    return;
  }
  
  btnVMs.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('Кнопка Машины нажата, vmModal:', vmModal);
    if (!vmModal) {
      console.error('vmModal не найден');
      return;
    }
    vmModal.style.setProperty('display', 'flex', 'important');
    console.log('Модальное окно открыто, display:', vmModal.style.display, 'computed:', window.getComputedStyle(vmModal).display);
    loadVMs();
    // Автообновление каждые 5 секунд
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
      if (vmModal && vmModal.style.display === 'flex') {
        loadVMs();
      }
    }, 5000);
  });
  
  if (btnCloseVM) {
    btnCloseVM.addEventListener('click', () => {
      vmModal.style.display = 'none';
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
    });
  }
  
  vmModal.addEventListener('click', (e) => {
    if (e.target === vmModal) {
      vmModal.style.display = 'none';
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
    }
  });
}

async function loadVMs() {
  try {
    const response = await fetch(VM_API + '/list');
    vms = await response.json();
    renderVMList();
  } catch (e) {
    vmList.innerHTML = '<div class="vm-empty">Ошибка загрузки машин</div>';
  }
}

function renderVMList() {
  if (!vms.length) {
    vmList.innerHTML = '<div class="vm-empty">Машины не найдены<br><small>Запусти парсер для поиска машин</small></div>';
    return;
  }
  
  // Загружаем сохраненные имена машин из localStorage
  const vmNames = JSON.parse(localStorage.getItem('vmNames') || '{}');
  
  vmList.innerHTML = vms.map((vm, index) => {
    const vmName = vmNames[vm.ip] || '';
    const displayName = vmName || `Машина ${index + 1}`;
    
    return `
      <div class="vm-card" data-ip="${vm.ip}">
        <div class="vm-card-header">
          <i class="fas fa-tag vm-card-name-icon"></i>
          <input type="text" class="vm-card-name" value="${displayName}" 
                 placeholder="Название машины" 
                 onchange="saveVMName('${vm.ip}', this.value)"
                 onblur="saveVMName('${vm.ip}', this.value)">
        </div>
        <div class="vm-card-body">
          <div class="vm-card-field">
            <div class="vm-card-value">
              <span class="vm-card-label"><i class="fas fa-network-wired"></i> IP:</span>
              <span class="vm-ip vm-copyable" data-copy="${vm.ip}" title="Кликните для копирования">${vm.ip}</span>
            </div>
          </div>
          <div class="vm-card-field">
            <div class="vm-card-value">
              <span class="vm-card-label"><i class="fas fa-fingerprint"></i> VM ID:</span>
              <span>${vm.instance_id || 'N/A'}</span>
            </div>
          </div>
          <div class="vm-card-field">
            <div class="vm-card-value">
              <span class="vm-card-label"><i class="fas fa-globe"></i> Зона:</span>
              <span>${vm.zone || 'N/A'}</span>
            </div>
          </div>
          <div class="vm-card-field">
            <div class="vm-card-value">
              <span class="vm-card-label"><i class="fas fa-user"></i> Логин:</span>
              <span>${vm.root_login || vm.username || 'root'}</span>
            </div>
          </div>
          <div class="vm-card-field">
            <div class="vm-card-value">
              <span class="vm-card-label"><i class="fas fa-key"></i> Пароль:</span>
              ${vm.root_password ? `<span class="vm-password vm-copyable" data-copy="${vm.root_password.replace(/"/g, '&quot;')}" title="Кликните для копирования">${vm.root_password}</span>` : '<span class="vm-no-password">Нет пароля</span>'}
            </div>
          </div>
          <div class="vm-card-field">
            <div class="vm-card-value">
              <span class="vm-card-label"><i class="fas fa-terminal"></i> SSH:</span>
              <span class="vm-ssh-command vm-copyable" data-copy="ssh ${vm.root_login || vm.username || 'root'}@${vm.ip}" title="Кликните для копирования">ssh ${vm.root_login || vm.username || 'root'}@${vm.ip}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  // Добавляем обработчики для кликабельных элементов копирования
  vmList.querySelectorAll('.vm-copyable').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = el.getAttribute('data-copy');
      if (text) {
        copyToClipboard(text);
        // Визуальная обратная связь
        const originalBg = el.style.backgroundColor;
        el.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
        setTimeout(() => {
          el.style.backgroundColor = originalBg;
        }, 300);
      }
    });
  });
}

function saveVMName(ip, name) {
  const vmNames = JSON.parse(localStorage.getItem('vmNames') || '{}');
  if (name.trim()) {
    vmNames[ip] = name.trim();
  } else {
    delete vmNames[ip];
  }
  localStorage.setItem('vmNames', JSON.stringify(vmNames));
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    // Показываем уведомление о копировании
    if (typeof showToast === 'function') {
      showToast('Скопировано в буфер обмена', 'success');
    } else {
      alert('Скопировано: ' + text);
    }
  }).catch(err => {
    console.error('Ошибка копирования:', err);
    // Fallback для старых браузеров
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      if (typeof showToast === 'function') {
        showToast('Скопировано в буфер обмена', 'success');
      }
    } catch (e) {
      alert('Ошибка копирования. Скопируйте вручную: ' + text);
    }
    document.body.removeChild(textarea);
  });
}

window.saveVMName = saveVMName;
window.copyToClipboard = copyToClipboard;


// Инициализация после загрузки DOM
window.addEventListener('load', () => {
  setTimeout(() => {
    try {
      const btn = document.getElementById('btnVMs');
      if (!btn) {
        console.error('Кнопка btnVMs не найдена');
        return;
      }
      initVMManager();
      console.log('VM Manager инициализирован');
    } catch (e) {
      console.error('Ошибка инициализации VM Manager:', e);
      console.error(e.stack);
    }
  }, 100);
});
