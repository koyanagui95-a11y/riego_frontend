(function () {
    const usuarioId = localStorage.getItem('userId');
    const username = localStorage.getItem('username');

    if (!usuarioId) {
        window.location.replace('login.html');
        return;
    }

    const usuarioActualEl = document.getElementById('usuario-actual');
    if (usuarioActualEl) usuarioActualEl.textContent = username || 'Usuario';

    document.getElementById('btnLogout').addEventListener('click', () => {
        localStorage.removeItem('userId');
        localStorage.removeItem('username');
        window.location.replace('login.html');
    });

    let bombaManual = false;
    let humedadChart = null;
    let todasLasLecturas = [];
    let filtroActual = 'dia';
    let esp32Online = false;
    let sensores = [];
    let tanqueBajo = false;

    const $ = (id) => document.getElementById(id);

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

    async function safeFetch(url, opts = {}) {
        const res = await fetch(url, {
            ...opts,
            headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
        });
        if (res.status === 401) {
            localStorage.clear();
            window.location.replace('login.html');
            throw new Error('Sesión expirada');
        }
        return res;
    }

    async function cargarConfiguracion() {
        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/config/${usuarioId}`);
            if (res.ok) {
                const data = await res.json();
                sensores = data.sensores || [];
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
            aplicarFiltroYRenderizar();
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
                    </div>
                `;
                container.appendChild(card);
            });

        const cardBomba = $('card-control-manual');
        const sensorBomba = sensores.find(s => s.tipo === 'bomba');
        if (cardBomba && sensorBomba && sensorBomba.habilitado === false) {
            cardBomba.classList.add('d-none');
        } else if (cardBomba) {
            cardBomba.classList.remove('d-none');
        }
    }

    function renderizarTablaHeader() {
        const thead = $('tabla-header');
        if (!thead) return;

        let html = '<tr><th>Fecha y Hora</th>';
        sensores.filter(s => s.habilitado).forEach(s => {
            html += `<th>${s.label}</th>`;
        });
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
            if (!res.ok) throw new Error('No se pudo obtener el estado del ESP32');
            const data = await res.json();

            esp32Online = !!data.online;
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
            }
        } catch (err) {
            console.error(err);
            esp32Online = false;
            renderizarEsp32Offline();
        }
    }

    async function cambiarBombaManual() {
        if (!esp32Online) {
            alert('El ESP32 está desconectado. Enciende el dispositivo y vuelve a intentarlo.');
            return;
        }
        if (tanqueBajo) {
            alert('El tanque está bajo. Rellena el tanque antes de activar la bomba.');
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
            alert('No se pudo controlar la bomba');
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

        sensores.filter(s => s.habilitado && s.tipo !== 'bomba').forEach(s => {
            const el = $('val-' + s.tipo);
            if (el) el.innerText = '---';
            const bar = $('bar-' + s.tipo);
            if (bar) bar.style.width = '0%';
        });

        if ($('fecha-val')) $('fecha-val').innerText = '---';

        const badge = $('bomba-status');
        if (badge) {
            badge.className = 'badge rounded-pill bg-danger px-4 py-2 fs-5';
            badge.innerHTML = '<i class="bi bi-wifi-off me-1"></i> SIN CONEXIÓN';
        }
        if ($('bomba-texto')) {
            $('bomba-texto').innerText = 'ESP32 apagado o sin conexión a internet.';
        }

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
        if (!esp32Online) return;
        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/lecturas/estado/${usuarioId}`);
            const data = res.ok ? await res.json() : null;

            if (!data || data.mensaje) {
                sensores.filter(s => s.habilitado && s.tipo !== 'bomba').forEach(s => {
                    const el = $('val-' + s.tipo);
                    if (el) el.innerText = '---';
                });
                return;
            }

            renderizarCardValores(data);

            const badge = $('bomba-status');
            const texto = $('bomba-texto');
            if (data.bombaActiva) {
                badge.className = 'badge rounded-pill bg-success px-4 py-2 fs-5';
                badge.innerHTML = '<i class="bi bi-water me-1"></i> ENCENDIDA';
                texto.innerText = 'Bomba activada.';
            } else {
                badge.className = 'badge rounded-pill bg-secondary px-4 py-2 fs-5';
                badge.innerHTML = '<i class="bi bi-power me-1"></i> APAGADA';
                texto.innerText = 'Sistema en espera.';
            }

            if (data.fechaRegistro) {
                $('fecha-val').innerText = new Date(data.fechaRegistro).toLocaleString('es-PE');
            }
        } catch (err) {
            console.error(err);
        }
    }

    async function obtenerLecturasHistoricas() {
        try {
            const res = await safeFetch(
                `${CONFIG.API_URL}/v1/lecturas/usuario/${usuarioId}?page=0&size=1000&sort=fechaRegistro,desc`
            );
            if (!res.ok) throw new Error('No se pudieron obtener las lecturas');

            const page = await res.json();
            todasLasLecturas = Array.isArray(page) ? page : (page.content || []);

            aplicarFiltroYRenderizar();
        } catch (err) {
            console.error('Error cargando historial:', err);
        }
    }

    function aplicarFiltroYRenderizar() {
        const ahora = new Date();
        let lecturasFiltradas = todasLasLecturas.filter(l => {
            if (!l.fechaRegistro) return false;
            const fechaLectura = new Date(l.fechaRegistro);
            const diffDias = (ahora - fechaLectura) / (1000 * 60 * 60 * 24);

            if (filtroActual === 'dia') {
                return fechaLectura.getFullYear() === ahora.getFullYear() &&
                    fechaLectura.getMonth() === ahora.getMonth() &&
                    fechaLectura.getDate() === ahora.getDate();
            } else if (filtroActual === 'semana') {
                return diffDias <= 7;
            } else if (filtroActual === 'quincenal') {
                return diffDias <= 15;
            } else if (filtroActual === 'mensual') {
                return diffDias <= 30;
            }
            return true;
        });

        lecturasFiltradas.sort((a, b) => new Date(a.fechaRegistro) - new Date(b.fechaRegistro));

        actualizarGrafico(lecturasFiltradas);
        actualizarTabla(lecturasFiltradas);
    }

    function actualizarGrafico(lecturas) {
        const etiquetas = lecturas.map(l => {
            const f = new Date(l.fechaRegistro);
            return filtroActual === 'dia'
                ? f.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
                : f.toLocaleDateString('es-PE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        });

        const datasets = [];
        const colores = { success: '#198754', danger: '#dc3545', info: '#0dcaf0', primary: '#0d6efd', warning: '#ffc107' };

        sensores
            .filter(s => s.habilitado && s.tipoValor === 'numero' && s.tipo !== 'bomba')
            .forEach(s => {
                const valores = lecturas.map(l => {
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
        if (humedadChart) humedadChart.destroy();

        humedadChart = new Chart(ctx, {
            type: 'line',
            data: { labels: etiquetas, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    y: { beginAtZero: true, title: { display: true, text: 'Valores' } },
                    x: { title: { display: true, text: 'Tiempo' } }
                },
                plugins: { legend: { display: true } }
            }
        });
    }

    function actualizarTabla(lecturas) {
        const tabla = $('tablaLecturas');
        const colSpan = 1 + sensores.filter(s => s.habilitado).length;
        tabla.innerHTML = '';

        if (lecturas.length === 0) {
            tabla.innerHTML = `<tr><td colspan="${colSpan}" class="text-muted">No hay lecturas registradas en este período.</td></tr>`;
            return;
        }

        lecturas.slice().reverse().forEach(l => {
            const fechaHora = new Date(l.fechaRegistro).toLocaleString('es-PE', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });

            let fila = `<td>${fechaHora}</td>`;
            sensores.filter(s => s.habilitado).forEach(s => {
                const raw = s.campo.startsWith('extras.')
                    ? getCampo(l.extras || {}, s.campo.substring(7))
                    : getCampo(l, s.campo);

                let txt = formatearValor(raw, s);
                if (s.tipoValor === 'numero' && s.unidad && raw != null) {
                    txt += ' ' + s.unidad;
                }
                fila += `<td>${txt}</td>`;
            });

            tabla.innerHTML += `<tr>${fila}</tr>`;
        });
    }

    document.querySelectorAll('.btn-group button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.btn-group button').forEach(b => b.classList.remove('active', 'btn-success'));
            document.querySelectorAll('.btn-group button').forEach(b => b.classList.add('btn-outline-success'));

            e.target.classList.add('active', 'btn-success');
            e.target.classList.remove('btn-outline-success');

            filtroActual = e.target.getAttribute('data-filtro');
            aplicarFiltroYRenderizar();
        });
    });

    document.getElementById('btnBombaManual').addEventListener('click', cambiarBombaManual);

    cargarConfiguracion().then(() => {
        obtenerEstadoManual();
        obtenerEstado();
        obtenerLecturasHistoricas();
    });

    setInterval(obtenerEstadoManual, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerEstado, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerLecturasHistoricas, CONFIG.POLL_LECTURAS_MS);
})();