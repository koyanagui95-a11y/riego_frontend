(function () {
    const token = localStorage.getItem('token');
    const usuarioId = localStorage.getItem('userId');
    const username = localStorage.getItem('username');
    const userRole = (localStorage.getItem('userRole') || localStorage.getItem('rol') || '').toUpperCase();

    if (!token || !usuarioId) {
        localStorage.clear();
        window.location.replace('login.html');
        return;
    }

    if (userRole !== 'CLIENTE') {
        localStorage.clear();
        window.location.replace('login.html?error=no_cliente');
        return;
    }

    const usuarioActualEl = document.getElementById('usuario-actual');
    if (usuarioActualEl) usuarioActualEl.textContent = username || 'Usuario';

    function mostrarNotificacionUI(mensaje, tipo = 'warning') {
        const toastEl = document.getElementById('appToast');
        const toastBody = document.getElementById('appToastBody');
        if (!toastEl || !toastBody) return;

        toastEl.className = `toast align-items-center text-bg-${tipo} border-0 shadow`;
        toastBody.textContent = mensaje;
        const toast = bootstrap.Toast.getOrCreateInstance(toastEl, { delay: 4000 });
        toast.show();
    }

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    let ultimaNotificacionOffline = 0;

    async function desuscribirPush() {
        try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
            }
        } catch (err) {
            console.warn('No se pudo desuscribir push:', err);
        }
    }

    document.getElementById('btnLogout').addEventListener('click', async () => {
        await desuscribirPush();
        localStorage.clear();
        window.location.replace('login.html');
    });

    let bombaManual = false;
    let humedadChart = null;
    let todasLasLecturas = [];
    let esp32Online = false;
    let estadoOnlineVerificado = false;
    let sensores = [];
    let tanqueBajo = false;
    let detallesAbierto = false;
    let tablaAbierta = false;

    const $ = (id) => document.getElementById(id);
    const CONFIG_CACHE_KEY = `riego_config_${usuarioId}`;
    const ESTADO_CACHE_KEY = `riego_estado_${usuarioId}`;

    const hoy = new Date();
    const filtroMesEl = $('filtroMes');
    const filtroDiaEl = $('filtroDia');

    function poblarDiasDelMes(mesIndex, diaSeleccionado) {
        if (!filtroDiaEl) return;
        const anio = hoy.getFullYear();
        const totalDias = new Date(anio, mesIndex + 1, 0).getDate();
        const diaObjetivo = Math.min(diaSeleccionado || hoy.getDate(), totalDias);

        filtroDiaEl.innerHTML = '';
        for (let d = 1; d <= totalDias; d++) {
            const opt = document.createElement('option');
            opt.value = String(d);
            opt.textContent = String(d).padStart(2, '0');
            if (d === diaObjetivo) opt.selected = true;
            filtroDiaEl.appendChild(opt);
        }
    }

    function aplicarFiltroFechaYRenderizar() {
        const lecturasDia = obtenerLecturasDelDiaSeleccionado();
        renderizarGrafico(lecturasDia);
        renderizarDetallesDelDia(lecturasDia);
    }

    if (filtroMesEl) {
        filtroMesEl.value = String(hoy.getMonth());
        poblarDiasDelMes(hoy.getMonth(), hoy.getDate());

        filtroMesEl.addEventListener('change', () => {
            const mes = parseInt(filtroMesEl.value, 10);
            const diaActual = parseInt(filtroDiaEl.value || String(hoy.getDate()), 10);
            poblarDiasDelMes(mes, diaActual);
            aplicFiltroFechaYRenderizar();
        });
    }

    function aplicFiltroFechaYRenderizar() {
        aplicarFiltroFechaYRenderizar();
    }

    if (filtroDiaEl) {
        filtroDiaEl.addEventListener('change', () => {
            aplicarFiltroFechaYRenderizar();
        });
    }

    function getCampo(obj, path) {
        if (!obj || !path) return undefined;
        return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }

    function formatearValor(valor, sensor) {
        if (valor === undefined || valor === null) return '---';
        if (sensor.tipoValor === 'booleano' && sensor.valores) {
            const key = String(valor === true ? '1' : valor === false ? '0' : valor);
            return sensor.valores[key] !== undefined ? sensor.valores[key] : (valor ? 'SÍ' : 'NO');
        }
        if (sensor.tipoValor === 'numero') {
            const n = Number(valor);
            if (isNaN(n)) return '---';
            return sensor.unidad === 'L/min' ? n.toFixed(2) : (Number.isInteger(n) ? n : n.toFixed(1));
        }
        return String(valor);
    }

    function formatearNumeroResumen(valor, unidad) {
        if (valor === null || valor === undefined || isNaN(valor)) return '---';
        return unidad === 'L/min' ? valor.toFixed(2) : valor.toFixed(1);
    }

    async function safeFetch(url, opts = {}) {
        const currentToken = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;

        const res = await fetch(url, { ...opts, headers });
        if (res.status === 401) {
            localStorage.clear();
            window.location.replace('login.html');
            throw new Error('Sesión expirada');
        }
        return res;
    }

    function leerCacheJson(clave) {
        try {
            const raw = localStorage.getItem(clave);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function guardarCacheJson(clave, valor) {
        try {
            localStorage.setItem(clave, JSON.stringify(valor));
        } catch (_) {}
    }

    async function cargarConfiguracion() {
        const cached = leerCacheJson(CONFIG_CACHE_KEY);
        if (cached && Array.isArray(cached.sensores) && cached.sensores.length > 0) {
            sensores = cached.sensores;
            renderizarTodo();
            const ultimoEstado = leerCacheJson(ESTADO_CACHE_KEY);
            if (ultimoEstado && !ultimoEstado.mensaje) {
                renderizarCardValores(ultimoEstado);
                if (ultimoEstado.fechaRegistro && $('fecha-val')) {
                    $('fecha-val').innerText = new Date(ultimoEstado.fechaRegistro).toLocaleString('es-PE');
                }
            }
        }

        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/config/${usuarioId}`);
            if (res.ok) {
                const data = await res.json();
                sensores = data.sensores || [];
                guardarCacheJson(CONFIG_CACHE_KEY, { sensores });
            }
        } catch (err) {
            console.error('No se pudo cargar config:', err);
        }
        renderizarTodo();
    }

    function renderizarTodo() {
        renderizarCards();
        renderizarTablaHeader();
        if (todasLasLecturas.length > 0) {
            aplicarFiltroFechaYRenderizar();
        }
    }

    function renderizarCards() {
        const container = $('cards-container');
        if (!container) return;
        container.innerHTML = '';

        sensores
            .filter(s => s.habilitado && s.tipo !== 'bomba')
            .forEach(s => {
                const card = document.createElement('div');
                card.className = 'col-md-3';
                card.setAttribute('data-sensor', s.tipo);
                card.innerHTML = `
                    <div class="card border-0 shadow-sm rounded-4 p-3 text-center h-100">
                        <h6 class="text-muted fw-semibold mb-2">${s.label.toUpperCase()}</h6>
                        <h2 class="fw-bold text-${s.color} mb-0">
                            <span id="val-${s.tipo}">---</span>${s.unidad ? ' <small class="fs-6">' + s.unidad + '</small>' : ''}
                        </h2>
                        ${s.tipo === 'suelo' ? '<div class="progress mt-2" style="height: 8px;"><div id="bar-' + s.tipo + '" class="progress-bar bg-' + s.color + '" style="width: 0%"></div></div>' : ''}
                    </div>`;
                container.appendChild(card);
            });

        const cardBomba = $('card-control-manual');
        const sensorBomba = sensores.find(s => s.tipo === 'bomba');
        if (cardBomba && sensorBomba && sensorBomba.habilitado === false) cardBomba.classList.add('d-none');
        else if (cardBomba) cardBomba.classList.remove('d-none');
    }

    function renderizarTablaHeader() {
        const thead = $('tabla-header');
        if (!thead) return;
        let html = '<tr><th>Hora</th>';
        sensores.filter(s => s.habilitado).forEach(s => { html += `<th>${s.label}</th>`; });
        html += '</tr>';
        thead.innerHTML = html;
    }

    function renderizarCardValores(data) {
        const extras = data.extras || {};
        sensores
            .filter(s => s.habilitado && s.tipo !== 'bomba')
            .forEach(s => {
                const el = $('val-' + s.tipo);
                if (!el) return;
                const valorRaw = s.campo.startsWith('extras.')
                    ? getCampo(extras, s.campo.substring(7))
                    : getCampo(data, s.campo);
                el.innerText = formatearValor(valorRaw, s);

                if (s.tipo === 'suelo') {
                    const bar = $('bar-' + s.tipo);
                    if (bar) {
                        const num = Number(valorRaw);
                        bar.style.width = `${isNaN(num) ? 0 : Math.max(0, Math.min(100, num))}%`;
                        bar.className = (num <= 40)
                            ? 'progress-bar bg-danger progress-bar-striped progress-bar-animated'
                            : 'progress-bar bg-success progress-bar-striped progress-bar-animated';
                    }
                }
            });
    }

    async function obtenerEstadoManual() {
        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/bomba/estado?usuarioId=${usuarioId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status} al obtener estado del ESP32`);
            const data = await res.json();

            esp32Online = !!data.online;
            estadoOnlineVerificado = true;
            bombaManual = !!data.bombaManual;

            const sensorTanque = sensores.find(s => s.tipo === 'tanque');
            const tanqueHabilitado = sensorTanque && sensorTanque.habilitado;
            tanqueBajo = tanqueHabilitado && (data.tanqueEstado === 0 || data.tanqueEstado === '0');

            if (esp32Online) {
                const banner = $('esp32-offline-banner');
                if (banner) banner.classList.add('d-none');
                actualizarBotonManual();
            } else {
                renderizarEsp32Offline();

                const ahoraNotif = Date.now();
                if (ahoraNotif - ultimaNotificacionOffline > 300000) {
                    if ('Notification' in window && Notification.permission === 'granted') {
                        new Notification('ESP32 desconectado', {
                            body: 'El dispositivo no tiene conexión a internet. El sistema operará localmente.',
                            icon: 'icono-riego-inteligente.png'
                        });
                    }
                    ultimaNotificacionOffline = ahoraNotif;
                }
            }
        } catch (err) {
            console.error(err);
            esp32Online = false;
            estadoOnlineVerificado = true;
            renderizarEsp32Offline();
        }
    }

    async function cambiarBombaManual() {
        if (!esp32Online) {
            mostrarNotificacionUI('El ESP32 está desconectado. Enciende el dispositivo y vuelve a intentarlo.', 'danger');
            return;
        }
        if (tanqueBajo) {
            mostrarNotificacionUI('El tanque está bajo. Rellena el tanque antes de activar la bomba.', 'warning');
            return;
        }
        try {
            const endpoint = bombaManual ? '/bomba/manual/apagar' : '/bomba/manual/encender';
            const res = await safeFetch(`${CONFIG.API_URL}/v1${endpoint}`, { method: 'POST' });
            if (!res.ok) throw new Error('No se pudo cambiar el estado');
            const data = await res.json();
            bombaManual = !!data.bombaManual;
            actualizarBotonManual();
            obtenerEstado();
            obtenerLecturasHistoricas();
        } catch (err) {
            console.error(err);
            mostrarNotificacionUI('No se pudo controlar la bomba en este momento.', 'danger');
        }
    }

    function actualizarBotonManual() {
        const boton = $('btnBombaManual');
        const estado = $('estadoManual');
        if (!boton || !estado) return;

        if (tanqueBajo) {
            boton.disabled = true;
            boton.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i> TANQUE BAJO';
            boton.classList.remove('btn-success', 'btn-danger', 'btn-secondary');
            boton.classList.add('btn-warning');
            estado.textContent = 'Estado: Bloqueado (tanque bajo)';
            return;
        }

        boton.disabled = false;
        boton.classList.remove('btn-warning');

        if (bombaManual) {
            estado.textContent = 'Estado: ENCENDIDA';
            boton.innerHTML = '<i class="bi bi-power me-1"></i> APAGAR BOMBA';
            boton.classList.remove('btn-success', 'btn-secondary');
            boton.classList.add('btn-danger');
        } else {
            estado.textContent = 'Estado: APAGADA';
            boton.innerHTML = '<i class="bi bi-power me-1"></i> ENCENDER BOMBA';
            boton.classList.remove('btn-danger', 'btn-secondary');
            boton.classList.add('btn-success');
        }
    }

    function renderizarEsp32Offline() {
        const banner = $('esp32-offline-banner');
        if (banner) banner.classList.remove('d-none');

        const badge = $('bomba-status');
        const texto = $('bomba-texto');
        if (badge) {
            badge.className = 'badge rounded-pill bg-danger px-4 py-2 fs-5';
            badge.innerHTML = '<i class="bi bi-wifi-off me-1"></i> SIN CONEXIÓN';
        }
        if (texto) texto.innerText = 'ESP32 apagado o sin conexión a internet.';

        const boton = $('btnBombaManual');
        const estado = $('estadoManual');
        if (boton) {
            boton.disabled = true;
            boton.innerHTML = '<i class="bi bi-wifi-off me-1"></i> ESP32 DESCONECTADO';
            boton.classList.remove('btn-success', 'btn-danger', 'btn-warning');
            boton.classList.add('btn-secondary');
        }
        if (estado) estado.textContent = 'Estado: ESP32 desconectado';
    }

    async function obtenerEstado() {
        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/lecturas/estado/${usuarioId}`);
            const data = res.ok ? await res.json() : null;

            if (!data || data.mensaje) {
                if (todasLasLecturas.length > 0) {
                    renderizarCardValores(todasLasLecturas[0]);
                }
                return;
            }

            guardarCacheJson(ESTADO_CACHE_KEY, data);
            renderizarCardValores(data);

            const badge = $('bomba-status');
            const texto = $('bomba-texto');
            if (badge && texto && (!estadoOnlineVerificado || esp32Online)) {
                if (data.bombaActiva) {
                    badge.className = 'badge rounded-pill bg-success px-4 py-2 fs-5';
                    badge.innerHTML = '<i class="bi bi-water me-1"></i> ENCENDIDA';
                    texto.innerText = 'Bomba activada.';
                } else {
                    badge.className = 'badge rounded-pill bg-secondary px-4 py-2 fs-5';
                    badge.innerHTML = '<i class="bi bi-power me-1"></i> APAGADA';
                    texto.innerText = 'Sistema en espera.';
                }
            }

            if (data.fechaRegistro && $('fecha-val')) {
                $('fecha-val').innerText = new Date(data.fechaRegistro).toLocaleString('es-PE');
            }
        } catch (err) {
            console.error(err);
        }
    }

    async function obtenerLecturasHistoricas() {
        try {
            const size = 1000;
            let page = 0;
            let totalPages = 1;
            const acumuladas = [];

            while (page < totalPages) {
                const res = await safeFetch(
                    `${CONFIG.API_URL}/v1/lecturas/usuario/${usuarioId}?page=${page}&size=${size}&sort=fechaRegistro,desc`
                );
                if (!res.ok) throw new Error(`HTTP ${res.status} al obtener las lecturas`);
                const data = await res.json();

                if (Array.isArray(data)) {
                    acumuladas.push(...data);
                    break;
                }

                const items = Array.isArray(data.content) ? data.content : [];
                acumuladas.push(...items);
                totalPages = typeof data.totalPages === 'number' && data.totalPages > 0 ? data.totalPages : 1;
                page += 1;
            }

            todasLasLecturas = acumuladas;
            if (todasLasLecturas.length > 0 && !leerCacheJson(ESTADO_CACHE_KEY)) {
                renderizarCardValores(todasLasLecturas[0]);
                if (todasLasLecturas[0].fechaRegistro && $('fecha-val')) {
                    $('fecha-val').innerText = new Date(todasLasLecturas[0].fechaRegistro).toLocaleString('es-PE');
                }
            }
            aplicarFiltroFechaYRenderizar();
        } catch (err) {
            console.error('Error cargando historial:', err);
        }
    }

    function obtenerLecturasDelDiaSeleccionado() {
        const mesSeleccionado = parseInt(filtroMesEl ? filtroMesEl.value : String(hoy.getMonth()), 10);
        const diaSeleccionado = parseInt(filtroDiaEl ? filtroDiaEl.value : String(hoy.getDate()), 10);

        return todasLasLecturas
            .filter(l => {
                if (!l.fechaRegistro) return false;
                const f = new Date(l.fechaRegistro);
                return f.getMonth() === mesSeleccionado && f.getDate() === diaSeleccionado;
            })
            .sort((a, b) => new Date(a.fechaRegistro) - new Date(b.fechaRegistro));
    }

    function renderizarGrafico(lecturasFiltradas) {
        const lista = Array.isArray(lecturasFiltradas) ? lecturasFiltradas : [];
        const wrapper = $('graficoInnerWrapper');
        const scrollContainer = $('graficoScrollContainer');
        if (wrapper) {
            const anchoPorPunto = 64;
            const anchoCalculado = Math.max(600, lista.length * anchoPorPunto);
            wrapper.style.width = lista.length > 10 ? `${anchoCalculado}px` : '100%';
        }

        const etiquetas = lista.map(l => {
            const f = new Date(l.fechaRegistro);
            return f.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
        });

        const datasets = [];
        const colores = { success: '#198754', danger: '#dc3545', info: '#0dcaf0', primary: '#0d6efd', warning: '#ffc107' };

        sensores
            .filter(s => s.habilitado && s.tipoValor === 'numero' && s.tipo !== 'bomba')
            .forEach(s => {
                const valores = lista.map(l => {
                    const raw = s.campo.startsWith('extras.')
                        ? getCampo(l.extras || {}, s.campo.substring(7))
                        : getCampo(l, s.campo);
                    const num = Number(raw);
                    return isNaN(num) ? null : num;
                });
                const color = colores[s.color] || '#6c757d';
                datasets.push({
                    label: `${s.label}${s.unidad ? ' (' + s.unidad + ')' : ''}`,
                    data: valores,
                    tension: 0.3,
                    borderColor: color,
                    backgroundColor: color + '20',
                    borderWidth: 2,
                    pointRadius: 3
                });
            });

        const ctx = $('humedadChart');
        if (!ctx) return;
        if (humedadChart) humedadChart.destroy();

        const mesTexto = filtroMesEl && filtroMesEl.options[filtroMesEl.selectedIndex]
            ? filtroMesEl.options[filtroMesEl.selectedIndex].text
            : '';
        const diaTexto = filtroDiaEl ? filtroDiaEl.value : '';
        const esHoy =
            filtroMesEl &&
            filtroDiaEl &&
            parseInt(filtroMesEl.value, 10) === hoy.getMonth() &&
            parseInt(filtroDiaEl.value, 10) === hoy.getDate();

        humedadChart = new Chart(ctx, {
            type: 'line',
            data: { labels: etiquetas, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    y: { beginAtZero: true, title: { display: true, text: 'Valores' } },
                    x: {
                        title: {
                            display: true,
                            text: esHoy ? 'Hora (Hoy)' : `Hora (${diaTexto} de ${mesTexto})`
                        }
                    }
                },
                plugins: { legend: { display: true } }
            }
        });

        if (scrollContainer) {
            scrollContainer.scrollLeft = scrollContainer.scrollWidth;
        }
    }

    function renderizarDetallesDelDia(lecturasParam) {
        const lecturasDia = Array.isArray(lecturasParam) ? lecturasParam : obtenerLecturasDelDiaSeleccionado();
        const mesTexto = filtroMesEl && filtroMesEl.options[filtroMesEl.selectedIndex]
            ? filtroMesEl.options[filtroMesEl.selectedIndex].text
            : '';
        const diaTexto = filtroDiaEl ? filtroDiaEl.value : '';

        const resumenFechaEl = $('resumenFechaTexto');
        if (resumenFechaEl) {
            resumenFechaEl.textContent = `${diaTexto} de ${mesTexto}`;
        }

        const contadorEl = $('contadorRegistrosDia');
        if (contadorEl) {
            contadorEl.textContent = `${lecturasDia.length} registro${lecturasDia.length === 1 ? '' : 's'} encontrado${lecturasDia.length === 1 ? '' : 's'}`;
        }

        renderizarTarjetasResumen(lecturasDia);
        actualizarTablaDia(lecturasDia);
    }

    function renderizarTarjetasResumen(lecturasDia) {
        const container = $('resumenCardsContainer');
        if (!container) return;
        container.innerHTML = '';

        const sensoresNumericos = sensores.filter(s => s.habilitado && s.tipoValor === 'numero' && s.tipo !== 'bomba');

        if (sensoresNumericos.length === 0) {
            container.innerHTML = '<div class="col-12 text-muted small">No hay sensores numéricos habilitados.</div>';
            return;
        }

        sensoresNumericos.forEach(s => {
            const valores = lecturasDia
                .map(l => {
                    const raw = s.campo.startsWith('extras.')
                        ? getCampo(l.extras || {}, s.campo.substring(7))
                        : getCampo(l, s.campo);
                    const n = Number(raw);
                    return isNaN(n) ? null : n;
                })
                .filter(v => v !== null);

            let minStr = '---';
            let maxStr = '---';
            let promStr = '---';

            if (valores.length > 0) {
                const min = Math.min(...valores);
                const max = Math.max(...valores);
                const prom = valores.reduce((acc, v) => acc + v, 0) / valores.length;
                minStr = formatearNumeroResumen(min, s.unidad);
                maxStr = formatearNumeroResumen(max, s.unidad);
                promStr = formatearNumeroResumen(prom, s.unidad);
            }

            const col = document.createElement('div');
            col.className = 'col-12 col-md-6 col-lg-3';
            col.innerHTML = `
                <div class="card border bg-light rounded-4 p-3 h-100">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <span class="fw-bold text-${s.color} small">${s.label.toUpperCase()}</span>
                        <span class="badge bg-white text-muted border">${s.unidad || ''}</span>
                    </div>
                    <div class="row text-center g-2 mt-1">
                        <div class="col-4">
                            <div class="text-muted" style="font-size: 0.72rem;">MÍNIMO</div>
                            <div class="fw-bold">${minStr}</div>
                        </div>
                        <div class="col-4 border-start border-end">
                            <div class="text-muted" style="font-size: 0.72rem;">PROMEDIO</div>
                            <div class="fw-bold text-${s.color}">${promStr}</div>
                        </div>
                        <div class="col-4">
                            <div class="text-muted" style="font-size: 0.72rem;">MÁXIMO</div>
                            <div class="fw-bold">${maxStr}</div>
                        </div>
                    </div>
                </div>`;
            container.appendChild(col);
        });
    }

    function actualizarTablaDia(lecturas) {
        const tabla = $('tablaLecturas');
        if (!tabla) return;
        const colSpan = 1 + sensores.filter(s => s.habilitado).length;
        tabla.innerHTML = '';

        if (lecturas.length === 0) {
            tabla.innerHTML = `<tr><td colspan="${colSpan}" class="text-muted py-3">No hay lecturas registradas para el día seleccionado.</td></tr>`;
            return;
        }

        lecturas.slice().reverse().forEach(l => {
            const hora = new Date(l.fechaRegistro).toLocaleTimeString('es-PE', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            let fila = `<td>${hora}</td>`;
            sensores.filter(s => s.habilitado).forEach(s => {
                const raw = s.campo.startsWith('extras.')
                    ? getCampo(l.extras || {}, s.campo.substring(7))
                    : getCampo(l, s.campo);

                let txt = formatearValor(raw, s);
                if (s.tipoValor === 'numero' && s.unidad && raw != null) txt += ' ' + s.unidad;
                fila += `<td>${txt}</td>`;
            });

            tabla.innerHTML += `<tr>${fila}</tr>`;
        });
    }

    const btnVerDetalles = $('btnVerDetalles');
    const panelDetalles = $('panelDetalles');
    const controlesFechaSuperior = $('controlesFechaSuperior');

    if (btnVerDetalles && panelDetalles) {
        btnVerDetalles.addEventListener('click', () => {
            detallesAbierto = !detallesAbierto;
            panelDetalles.classList.toggle('d-none', !detallesAbierto);

            if (controlesFechaSuperior) {
                controlesFechaSuperior.classList.toggle('d-none', !detallesAbierto);
                controlesFechaSuperior.classList.toggle('d-flex', detallesAbierto);
            }

            btnVerDetalles.setAttribute('aria-expanded', String(detallesAbierto));
            btnVerDetalles.innerHTML = detallesAbierto
                ? '<i class="bi bi-chevron-up me-1"></i>Ocultar detalles'
                : '<i class="bi bi-sliders2 me-1"></i>Ver detalles';

            if (detallesAbierto) {
                aplicarFiltroFechaYRenderizar();
            }
        });
    }

    const btnVerDatos = $('btnVerDatos');
    const contenedorTablaDia = $('contenedorTablaDia');
    if (btnVerDatos && contenedorTablaDia) {
        btnVerDatos.addEventListener('click', () => {
            tablaAbierta = !tablaAbierta;
            contenedorTablaDia.classList.toggle('d-none', !tablaAbierta);
            btnVerDatos.setAttribute('aria-expanded', String(tablaAbierta));
            btnVerDatos.innerHTML = tablaAbierta
                ? '<i class="bi bi-eye-slash me-1"></i>Ocultar datos'
                : '<i class="bi bi-table me-1"></i>Ver datos';
        });
    }

    async function registrarPush() {
        try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

            const registration = await navigator.serviceWorker.register('./sw.js');
            const vapidRes = await fetch(`${CONFIG.API_URL}/push/vapid-public-key`);
            if (!vapidRes.ok) return;
            const vapidData = await vapidRes.json();
            if (!vapidData.publicKey) return;

            const applicationServerKey = urlBase64ToUint8Array(vapidData.publicKey);
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey
            });

            const headers = { 'Content-Type': 'application/json' };
            const currentToken = localStorage.getItem('token');
            if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;

            await fetch(`${CONFIG.API_URL}/push/subscribe`, {
                method: 'POST',
                headers,
                body: JSON.stringify(subscription)
            });
        } catch (err) {
            console.warn('Push no disponible:', err);
        }
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
        return outputArray;
    }

    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        const btn = document.getElementById('btnInstallPwa');
        if (btn) btn.classList.remove('d-none');
    });

    const btnInstall = document.getElementById('btnInstallPwa');
    if (btnInstall) {
        btnInstall.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log('Instalación:', outcome);
            deferredPrompt = null;
            btnInstall.classList.add('d-none');
        });
    }

    window.addEventListener('appinstalled', () => {
        const btn = document.getElementById('btnInstallPwa');
        if (btn) btn.classList.add('d-none');
        deferredPrompt = null;
    });

    registrarPush();

    document.getElementById('btnBombaManual').addEventListener('click', cambiarBombaManual);

    const btnConfigWifi = document.getElementById('btnConfigWifi');
    if (btnConfigWifi) {
        btnConfigWifi.addEventListener('click', () => {
            new bootstrap.Modal(document.getElementById('wifiModal')).show();
        });
    }

    const wifiForm = document.getElementById('wifiForm');
    if (wifiForm) {
        wifiForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const alertEl = document.getElementById('wifiAlert');
            alertEl.classList.add('d-none');

            const ssid = document.getElementById('wifiSsid').value.trim();
            const password = document.getElementById('wifiPassword').value;
            const btn = document.getElementById('btnGuardarWifi');

            if (!ssid) {
                alertEl.className = 'alert alert-warning';
                alertEl.textContent = 'Ingresa el nombre de la red.';
                alertEl.classList.remove('d-none');
                return;
            }
            if (password.length < 8) {
                alertEl.className = 'alert alert-warning';
                alertEl.textContent = 'La contraseña debe tener al menos 8 caracteres.';
                alertEl.classList.remove('d-none');
                return;
            }
            if (!esp32Online) {
                alertEl.className = 'alert alert-danger';
                alertEl.textContent = 'El ESP32 está desconectado. Enciéndelo antes de cambiar el WiFi.';
                alertEl.classList.remove('d-none');
                return;
            }

            btn.disabled = true;
            try {
                const res = await safeFetch(`${CONFIG.API_URL}/v1/wifi/${usuarioId}`, {
                    method: 'POST',
                    body: JSON.stringify({ ssid, password })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.mensaje || 'No se pudo enviar la solicitud');

                alertEl.className = 'alert alert-success';
                alertEl.textContent = 'Solicitud enviada. El ESP32 se reconectará en unos segundos.';
                alertEl.classList.remove('d-none');

                wifiForm.reset();
                setTimeout(() => {
                    bootstrap.Modal.getInstance(document.getElementById('wifiModal')).hide();
                }, 2500);
            } catch (err) {
                alertEl.className = 'alert alert-danger';
                alertEl.textContent = err.message || 'Error al enviar la solicitud.';
                alertEl.classList.remove('d-none');
            } finally {
                btn.disabled = false;
            }
        });
    }

    cargarConfiguracion().then(() => {
        Promise.allSettled([
            obtenerEstado(),
            obtenerLecturasHistoricas(),
            obtenerEstadoManual()
        ]);
    });

    setInterval(obtenerEstadoManual, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerEstado, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerLecturasHistoricas, CONFIG.POLL_LECTURAS_MS);
})();
