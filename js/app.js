(function () {
    const $ = (id) => document.getElementById(id);

    let bombaManual = false;
    let humedadChart = null;
    let todasLasLecturas = [];
    let dispositivoOnline = false;
    let estadoOnlineVerificado = false;
    let sensores = [];
    let tanqueBajo = false;
    let alertaFlujoActiva = false;
    let deferredPrompt = null;

    const ahoraInit = new Date();
    let mesSeleccionado = ahoraInit.getMonth();
    let diaSeleccionado = ahoraInit.getDate();

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

    const CONFIG_CACHE_KEY = `riego_config_${usuarioId}`;
    const ESTADO_CACHE_KEY = `riego_estado_${usuarioId}`;

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch(() => { });
        });
    }

    function inicializarSelectoresFecha() {
        const selMes = $('filtroMes');
        const selDia = $('filtroDia');
        if (!selMes || !selDia) return;

        const nombresMeses = [
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
        ];

        selMes.innerHTML = '';
        nombresMeses.forEach((nombre, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            opt.textContent = nombre;
            if (idx === mesSeleccionado) opt.selected = true;
            selMes.appendChild(opt);
        });

        function poblarDias(mes) {
            const anioActual = new Date().getFullYear();
            const diasEnMes = new Date(anioActual, mes + 1, 0).getDate();
            if (diaSeleccionado > diasEnMes) diaSeleccionado = diasEnMes;

            selDia.innerHTML = '';
            for (let d = 1; d <= diasEnMes; d++) {
                const opt = document.createElement('option');
                opt.value = String(d);
                opt.textContent = `Día ${d}`;
                if (d === diaSeleccionado) opt.selected = true;
                selDia.appendChild(opt);
            }
        }

        poblarDias(mesSeleccionado);

        selMes.addEventListener('change', () => {
            mesSeleccionado = parseInt(selMes.value, 10);
            poblarDias(mesSeleccionado);
            aplicarFiltroYRenderizar();
        });

        selDia.addEventListener('change', () => {
            diaSeleccionado = parseInt(selDia.value, 10);
            aplicarFiltroYRenderizar();
        });
    }

    function mostrarNotificacion(mensaje, tipo = 'info') {
        const toastEl = $('appToast');
        const toastBody = $('appToastBody');
        if (toastEl && toastBody && window.bootstrap && bootstrap.Toast) {
            toastEl.className = `toast align-items-center text-bg-${tipo} border-0 shadow`;
            toastBody.textContent = mensaje;
            const toast = bootstrap.Toast.getOrCreateInstance(toastEl, { delay: 4000 });
            toast.show();
        }
    }

    const usuarioActualEl = $('usuario-actual');
    if (usuarioActualEl) usuarioActualEl.textContent = username || 'Usuario';

    async function desuscribirPush() {
        try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
            }
        } catch (err) { }
    }

    const btnLogout = $('btnLogout');
    if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
            await desuscribirPush();
            localStorage.clear();
            window.location.replace('login.html');
        });
    }

    function getCampo(obj, path) {
        if (!obj || !path) return undefined;
        return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }

    function obtenerValorSensorNumero(lectura, sensor) {
        const raw = sensor.campo.startsWith('extras.')
            ? getCampo(lectura.extras || {}, sensor.campo.substring(7))
            : getCampo(lectura, sensor.campo);
        if (raw === undefined || raw === null || raw === '') return null;
        const num = Number(raw);
        return Number.isNaN(num) ? null : num;
    }

    function formatearEstadisticaNumero(valor, sensor) {
        if (valor === null || valor === undefined || Number.isNaN(valor)) return '---';
        const formatted = sensor.unidad === 'L/min'
            ? valor.toFixed(2)
            : (Number.isInteger(valor) ? String(valor) : valor.toFixed(1));
        return sensor.unidad ? `${formatted} ${sensor.unidad}` : formatted;
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

    async function safeFetch(url, opts = {}) {
        const currentToken = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;
        const res = await fetch(url, { ...opts, headers });
        if (res.status === 401 || res.status === 403) {
            const data = await res.json().catch(() => ({}));
            localStorage.clear();
            sessionStorage.setItem('loginNotice', data.mensaje || 'Tu sesión expiró o el servicio fue suspendido.');
            sessionStorage.setItem('loginNoticeType', 'danger');
            window.location.replace('login.html');
            throw new Error('Acceso no autorizado');
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
        } catch (_) { }
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
                sensores = Array.isArray(data) ? data : (data.sensores || []);
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
        if (todasLasLecturas.length > 0) aplicarFiltroYRenderizar();
    }

    function renderizarCards() {
        const container = $('cards-container');
        if (!container) return;
        container.innerHTML = '';
        sensores
            .filter(s => s.habilitado && s.tipo !== 'bomba')
            .forEach(s => {
                const card = document.createElement('div');
                card.className = 'col-6 col-md-3';
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
        let html = '<tr><th>Fecha y Hora</th>';
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
            if (!res.ok) throw new Error('No se pudo obtener el estado del dispositivo');
            const data = await res.json();

            dispositivoOnline = !!data.online;
            estadoOnlineVerificado = true;
            bombaManual = !!data.bombaManual;
            alertaFlujoActiva = !!data.alertaFlujo;

            const sensorTanque = sensores.find(s => s.tipo === 'tanque');
            const tanqueHabilitado = sensorTanque && sensorTanque.habilitado;
            tanqueBajo = tanqueHabilitado && (data.tanqueEstado === 0 || data.tanqueEstado === '0');

            const bannerFlujo = $('flujo-alerta-banner');
            if (bannerFlujo) bannerFlujo.classList.toggle('d-none', !alertaFlujoActiva);

            if (dispositivoOnline) {
                const banner = $('esp32-offline-banner');
                if (banner) banner.classList.add('d-none');
                actualizarBotonManual();
            } else {
                renderizarDispositivoOffline();
            }
        } catch (err) {
            console.error(err);
            dispositivoOnline = false;
            estadoOnlineVerificado = true;
            renderizarDispositivoOffline();
        }
    }

    async function cambiarBombaManual() {
        if (!dispositivoOnline) {
            mostrarNotificacion('El dispositivo está desconectado. Verifica su alimentación y conexión.', 'danger');
            return;
        }
        if (tanqueBajo) {
            mostrarNotificacion('Nivel de agua bajo. Rellena el tanque antes de activar la bomba.', 'warning');
            return;
        }
        const seVaAEncender = !bombaManual;
        try {
            const endpoint = bombaManual ? '/bomba/manual/apagar' : '/bomba/manual/encender';
            const res = await safeFetch(
                `${CONFIG.API_URL}/v1${endpoint}?usuarioId=${encodeURIComponent(usuarioId)}`,
                { method: 'POST' }
            );
            if (!res.ok) throw new Error('No se pudo cambiar el estado');
            const data = await res.json();
            bombaManual = !!data.bombaManual;
            actualizarBotonManual();
            obtenerEstado();
            if (seVaAEncender && bombaManual) {
                mostrarNotificacion('Bomba encendida. Verificando flujo de agua...', 'info');
                setTimeout(verificarFlujoTrasEncendido, 11000);
            }
        } catch (err) {
            console.error(err);
            mostrarNotificacion('No se pudo controlar la bomba en este momento.', 'danger');
        }
    }

    async function verificarFlujoTrasEncendido() {
        if (!bombaManual) return;
        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/lecturas/estado/${usuarioId}`);
            if (!res.ok) return;
            const data = await res.json();
            if (!data || data.mensaje) return;
            const flujo = Number(data.flujoAgua ?? 0);
            if (flujo < 0.05) {
                mostrarNotificacion(
                    'La bomba está encendida pero no sale agua. Revisa la energía de la mini bomba.',
                    'warning'
                );
                await obtenerEstadoManual();
            } else {
                mostrarNotificacion('Flujo de agua detectado correctamente.', 'success');
            }
        } catch (err) { }
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
        if (alertaFlujoActiva) {
            boton.disabled = false;
            boton.innerHTML = '<i class="bi bi-power me-1"></i> ENCENDER BOMBA';
            boton.classList.remove('btn-danger', 'btn-warning', 'btn-secondary');
            boton.classList.add('btn-success');
            estado.textContent = 'Estado: Alerta de flujo — bomba apagada';
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

    function renderizarDispositivoOffline() {
        const banner = $('esp32-offline-banner');
        if (banner) banner.classList.remove('d-none');

        const badge = $('bomba-status');
        if (badge) {
            badge.className = 'badge rounded-pill bg-danger px-4 py-2 fs-5';
            badge.innerHTML = '<i class="bi bi-wifi-off me-1"></i> SIN CONEXIÓN';
        }
        if ($('bomba-texto')) $('bomba-texto').innerText = 'Dispositivo sin conexión a internet.';
        const boton = $('btnBombaManual');
        const estado = $('estadoManual');
        if (boton) {
            boton.disabled = true;
            boton.innerHTML = '<i class="bi bi-wifi-off me-1"></i> SIN CONEXIÓN';
            boton.classList.remove('btn-success', 'btn-danger', 'btn-warning');
            boton.classList.add('btn-secondary');
        }
        if (estado) estado.textContent = 'Estado: Sin conexión';
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
            if (badge && texto && (!estadoOnlineVerificado || dispositivoOnline)) {
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
            const res = await safeFetch(
                `${CONFIG.API_URL}/v1/lecturas/usuario/${usuarioId}?page=0&size=2000&sort=fechaRegistro,desc`
            );
            if (!res.ok) throw new Error('No se pudieron obtener las lecturas');
            const page = await res.json();
            todasLasLecturas = Array.isArray(page) ? page : (page.content || []);
            if (todasLasLecturas.length > 0 && !leerCacheJson(ESTADO_CACHE_KEY)) {
                renderizarCardValores(todasLasLecturas[0]);
                if (todasLasLecturas[0].fechaRegistro && $('fecha-val')) {
                    $('fecha-val').innerText = new Date(todasLasLecturas[0].fechaRegistro).toLocaleString('es-PE');
                }
            }
            aplicarFiltroYRenderizar();
        } catch (err) {
            console.error('Error cargando historial:', err);
        }
    }

    function aplicarFiltroYRenderizar() {
        const lecturasFiltradas = todasLasLecturas.filter(l => {
            if (!l.fechaRegistro) return false;
            const f = new Date(l.fechaRegistro);
            return f.getMonth() === mesSeleccionado && f.getDate() === diaSeleccionado;
        });
        lecturasFiltradas.sort((a, b) => new Date(a.fechaRegistro) - new Date(b.fechaRegistro));
        actualizarGrafico(lecturasFiltradas);
        actualizarEstadisticasDetalles(lecturasFiltradas);
        actualizarTabla(lecturasFiltradas);
    }

    function actualizarEstadisticasDetalles(lecturas) {
        const contenedor = $('estadisticasDetalles');
        if (!contenedor) return;

        const sensoresNumericos = sensores.filter(
            s => s.habilitado && s.tipoValor === 'numero' && s.tipo !== 'bomba'
        );

        if (sensoresNumericos.length === 0) {
            contenedor.innerHTML = `
                <div class="col-12">
                    <div class="alert alert-light border text-muted small mb-0 text-center">
                        No hay sensores numéricos configurados para calcular estadísticas.
                    </div>
                </div>`;
            return;
        }

        if (!lecturas || lecturas.length === 0) {
            contenedor.innerHTML = `
                <div class="col-12">
                    <div class="alert alert-light border text-muted small mb-0 text-center">
                        No hay lecturas en este día para calcular mínimo, máximo y promedio.
                    </div>
                </div>`;
            return;
        }

        const coloresBorde = {
            success: 'border-success',
            danger: 'border-danger',
            info: 'border-info',
            primary: 'border-primary',
            warning: 'border-warning'
        };

        contenedor.innerHTML = sensoresNumericos.map(s => {
            const valores = lecturas
                .map(l => obtenerValorSensorNumero(l, s))
                .filter(v => v !== null);

            if (valores.length === 0) {
                return `
                    <div class="col-12 col-sm-6 col-lg-4">
                        <div class="card border-0 shadow-sm rounded-3 p-3 h-100 bg-white">
                            <div class="d-flex justify-content-between align-items-center mb-2">
                                <span class="fw-bold text-${s.color || 'secondary'} small text-uppercase">${s.label}</span>
                                <span class="badge bg-light text-muted border">Sin datos</span>
                            </div>
                            <p class="text-muted small mb-0">Sin valores numéricos registrados.</p>
                        </div>
                    </div>`;
            }

            const minVal = Math.min(...valores);
            const maxVal = Math.max(...valores);
            const promVal = valores.reduce((acc, v) => acc + v, 0) / valores.length;
            const bordeClase = coloresBorde[s.color] || 'border-secondary';

            return `
                <div class="col-12 col-sm-6 col-lg-4">
                    <div class="card border-0 border-start border-4 ${bordeClase} shadow-sm rounded-3 p-3 h-100 bg-white">
                        <div class="d-flex justify-content-between align-items-center mb-2">
                            <span class="fw-bold text-${s.color || 'dark'} small text-uppercase">${s.label}</span>
                            <span class="badge bg-light text-muted border">${valores.length} reg.</span>
                        </div>
                        <div class="row g-2 text-center">
                            <div class="col-4">
                                <div class="p-2 rounded-2 bg-light">
                                    <div class="text-muted" style="font-size: 0.7rem;">MÍNIMO</div>
                                    <div class="fw-bold text-primary small mt-1">${formatearEstadisticaNumero(minVal, s)}</div>
                                </div>
                            </div>
                            <div class="col-4">
                                <div class="p-2 rounded-2 bg-light">
                                    <div class="text-muted" style="font-size: 0.7rem;">MÁXIMO</div>
                                    <div class="fw-bold text-danger small mt-1">${formatearEstadisticaNumero(maxVal, s)}</div>
                                </div>
                            </div>
                            <div class="col-4">
                                <div class="p-2 rounded-2 bg-light">
                                    <div class="text-muted" style="font-size: 0.7rem;">PROMEDIO</div>
                                    <div class="fw-bold text-success small mt-1">${formatearEstadisticaNumero(promVal, s)}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>`;
        }).join('');
    }

    function actualizarGrafico(lecturas) {
        const wrapper = $('graficoInnerWrapper');
        const scrollContainer = $('graficoScrollContainer');
        const ctx = $('humedadChart');
        if (!ctx) return;

        const esMovil = window.innerWidth <= 576;
        const maxPuntosConScroll = esMovil ? 90 : 140;
        const lecturasGrafico = lecturas.length > maxPuntosConScroll
            ? lecturas.slice(-maxPuntosConScroll)
            : lecturas;

        if (wrapper) {
            const anchoPorPunto = esMovil ? 44 : 52;
            const anchoMinimo = esMovil ? 480 : 640;
            const anchoCalculado = Math.min(5400, Math.max(anchoMinimo, lecturasGrafico.length * anchoPorPunto));
            wrapper.style.width = lecturasGrafico.length > 8 ? `${anchoCalculado}px` : '100%';
        }

        const etiquetas = lecturasGrafico.map(l => {
            const f = new Date(l.fechaRegistro);
            return f.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        });

        const colores = {
            success: '#198754',
            danger: '#dc3545',
            info: '#0dcaf0',
            primary: '#0d6efd',
            warning: '#ffc107'
        };

        const radioPunto = lecturasGrafico.length > 80 ? 1.8 : (esMovil ? 2.2 : 2.5);

        const datasets = sensores
            .filter(s => s.habilitado && s.tipoValor === 'numero' && s.tipo !== 'bomba')
            .map(s => {
                const valores = lecturasGrafico.map(l => obtenerValorSensorNumero(l, s));
                const color = colores[s.color] || '#6c757d';
                return {
                    label: `${s.label}${s.unidad ? ' (' + s.unidad + ')' : ''}`,
                    data: valores,
                    tension: 0.25,
                    borderColor: color,
                    backgroundColor: color,
                    borderWidth: esMovil ? 2.2 : 2,
                    borderCapStyle: 'round',
                    borderJoinStyle: 'round',
                    pointRadius: radioPunto,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: color,
                    pointBorderWidth: 1.75,
                    spanGaps: true
                };
            });

        if (humedadChart) {
            humedadChart.destroy();
            humedadChart = null;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 3);

        humedadChart = new Chart(ctx, {
            type: 'line',
            data: { labels: etiquetas, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                devicePixelRatio: dpr,
                animation: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: { display: !esMovil, text: 'Valores' },
                        grid: { color: 'rgba(0, 0, 0, 0.06)' },
                        ticks: {
                            font: { size: esMovil ? 10 : 12 }
                        }
                    },
                    x: {
                        title: { display: !esMovil, text: 'Hora' },
                        grid: { color: 'rgba(0, 0, 0, 0.06)' },
                        ticks: {
                            maxRotation: esMovil ? 45 : 35,
                            minRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: esMovil ? 12 : 24,
                            font: { size: esMovil ? 10 : 12 }
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            usePointStyle: true,
                            boxWidth: 8,
                            font: { size: esMovil ? 11 : 12 }
                        }
                    },
                    tooltip: {
                        padding: esMovil ? 8 : 10,
                        titleFont: { size: esMovil ? 11 : 12 },
                        bodyFont: { size: esMovil ? 11 : 12 },
                        boxWidth: 10
                    }
                }
            }
        });

        requestAnimationFrame(() => {
            if (humedadChart) humedadChart.resize();
            if (scrollContainer) {
                scrollContainer.scrollLeft = scrollContainer.scrollWidth;
            }
        });
    }

    function actualizarTabla(lecturas) {
        const tabla = $('tablaLecturas');
        if (!tabla) return;
        const colSpan = 1 + sensores.filter(s => s.habilitado).length;
        tabla.innerHTML = '';
        if (lecturas.length === 0) {
            tabla.innerHTML = `<tr><td colspan="${colSpan}" class="text-muted">No hay lecturas registradas en este día.</td></tr>`;
            return;
        }
        lecturas.slice().reverse().forEach(l => {
            const fechaHora = new Date(l.fechaRegistro).toLocaleString('es-PE', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            let fila = `<td>${fechaHora}</td>`;
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

    async function registrarPush() {
        try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
            let registration = await navigator.serviceWorker.getRegistration();
            if (!registration) registration = await navigator.serviceWorker.register('./sw.js');

            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
                const vapidRes = await fetch(`${CONFIG.API_URL}/push/vapid-public-key`);
                if (!vapidRes.ok) return;
                const vapidData = await vapidRes.json();
                if (!vapidData.publicKey) return;
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey)
                });
            }

            const currentToken = localStorage.getItem('token');
            const headers = { 'Content-Type': 'application/json' };
            if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;
            await fetch(`${CONFIG.API_URL}/push/subscribe`, {
                method: 'POST', headers, body: JSON.stringify(subscription)
            });
        } catch (err) { console.warn('Push no disponible:', err); }
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
        return outputArray;
    }

    inicializarSelectoresFecha();
    registrarPush();

    const btnBombaManual = $('btnBombaManual');
    if (btnBombaManual) btnBombaManual.addEventListener('click', cambiarBombaManual);

    cargarConfiguracion().then(() => {
        obtenerEstadoManual();
        obtenerEstado();
        obtenerLecturasHistoricas();
    });

    setInterval(obtenerEstadoManual, CONFIG.POLL_ESTADO_MS || 2000);
    setInterval(obtenerEstado, CONFIG.POLL_ESTADO_MS || 2000);
    setInterval(obtenerLecturasHistoricas, CONFIG.POLL_LECTURAS_MS || 600000);

    const btnConfigWifi = $('btnConfigWifi');
    if (btnConfigWifi) {
        btnConfigWifi.addEventListener('click', () => {
            const modalEl = $('wifiModal');
            if (modalEl && window.bootstrap && bootstrap.Modal) {
                bootstrap.Modal.getOrCreateInstance(modalEl).show();
            } else {
                mostrarNotificacion('Abre el panel de configuración de red del equipo para actualizar el WiFi.', 'info');
            }
        });
    }

    const wifiForm = $('wifiForm');
    if (wifiForm) {
        wifiForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const ssid = $('wifiSsid').value.trim();
            const password = $('wifiPassword').value;
            if (!ssid || password.length < 8) {
                mostrarNotificacion('Ingresa un SSID válido y una contraseña de al menos 8 caracteres.', 'warning');
                return;
            }
            try {
                const res = await safeFetch(`${CONFIG.API_URL}/v1/wifi/${usuarioId}`, {
                    method: 'POST',
                    body: JSON.stringify({ ssid, password })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.mensaje || 'Error al enviar la configuración WiFi.');
                mostrarNotificacion('Solicitud enviada. El ESP32 cambiará de red en unos segundos.', 'success');
                bootstrap.Modal.getInstance($('wifiModal'))?.hide();
            } catch (err) {
                mostrarNotificacion(err.message, 'danger');
            }
        });
    }

    const btnVerDetalles = $('btnVerDetalles');
    if (btnVerDetalles) {
        btnVerDetalles.addEventListener('click', () => {
            const panel = $('panelDetalles');
            if (!panel) return;
            const isHidden = panel.classList.contains('d-none');
            panel.classList.toggle('d-none', !isHidden);
            btnVerDetalles.setAttribute('aria-expanded', String(isHidden));
            btnVerDetalles.innerHTML = isHidden
                ? '<i class="bi bi-sliders2 me-1"></i>Ocultar detalles'
                : '<i class="bi bi-sliders2 me-1"></i>Ver detalles';
        });
    }

    const btnVerDatos = $('btnVerDatos');
    if (btnVerDatos) {
        btnVerDatos.addEventListener('click', () => {
            const cont = $('contenedorTablaDia');
            if (!cont) return;
            const isHidden = cont.classList.contains('d-none');
            cont.classList.toggle('d-none', !isHidden);
            btnVerDatos.setAttribute('aria-expanded', String(isHidden));
            btnVerDatos.innerHTML = isHidden
                ? '<i class="bi bi-table me-1"></i>Ocultar datos'
                : '<i class="bi bi-table me-1"></i>Ver datos';
        });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        const btn = $('btnInstallPwa');
        if (btn) btn.classList.remove('d-none');
    });

    const btnInstallPwa = $('btnInstallPwa');
    if (btnInstallPwa) {
        btnInstallPwa.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
            deferredPrompt = null;
            btnInstallPwa.classList.add('d-none');
        });
    }

    window.addEventListener('appinstalled', () => {
        const btn = $('btnInstallPwa');
        if (btn) btn.classList.add('d-none');
        deferredPrompt = null;
    });
})();
