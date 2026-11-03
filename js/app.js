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

    const $ = (id) => document.getElementById(id);

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

    async function obtenerEstadoManual() {
        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/bomba/manual`);
            if (!res.ok) throw new Error('No se pudo obtener el estado manual');
            const data = await res.json();
            bombaManual = !!data.bombaManual;
            actualizarBotonManual();
        } catch (err) {
            console.error(err);
            const estado = $('estadoManual');
            if (estado) estado.textContent = 'Estado: sin conexión';
        }
    }

    async function cambiarBombaManual() {
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

        if (bombaManual) {
            estado.textContent = 'Estado: ENCENDIDA';
            boton.innerHTML = '<i class="bi bi-power me-1"></i> APAGAR BOMBA';
            boton.classList.replace('btn-success', 'btn-danger');
        } else {
            estado.textContent = 'Estado: APAGADA';
            boton.innerHTML = '<i class="bi bi-power me-1"></i> ENCENDER BOMBA';
            boton.classList.replace('btn-danger', 'btn-success');
        }
    }

    async function obtenerEstado() {
        try {
            const res = await safeFetch(`${CONFIG.API_URL}/v1/lecturas/estado/${usuarioId}`);
            if (!res.ok) {
                renderizarSistemaApagado();
                return;
            }
            actualizarInterfaz(await res.json());
        } catch (err) {
            console.error(err);
            renderizarSistemaApagado();
        }
    }

    function renderizarSistemaApagado() {
        const badge = $('bomba-status');
        if (badge) {
            badge.className = 'badge rounded-pill bg-secondary px-4 py-2 fs-5';
            badge.innerHTML = '<i class="bi bi-power me-1"></i> APAGADO';
        }
        if ($('bomba-texto')) $('bomba-texto').innerText = 'Sistema Apagado / Sin datos.';
        if ($('humedad-val')) $('humedad-val').innerText = '--';
        if ($('humedad-bar')) $('humedad-bar').style.width = '0%';
        if ($('humedad-ambiente-val')) $('humedad-ambiente-val').innerText = '--';
        if ($('temperatura-val')) $('temperatura-val').innerText = '--';
        if ($('flujo-val')) $('flujo-val').innerText = '--';
        if ($('fecha-val')) $('fecha-val').innerText = '--';
    }

    function actualizarInterfaz(data) {
        if (data.mensaje) {
            renderizarSistemaApagado();
            if ($('bomba-texto')) $('bomba-texto').innerText = 'Sistema Apagado / Esperando primera lectura.';
            return;
        }

        const humedadSuelo = data.humedad_suelo;
        const humedadAmbiente = data.humedad_ambiente;
        const temperatura = data.temperatura;
        const flujoAgua = data.flujoAgua;

        $('humedad-val').innerText = humedadSuelo ?? '--';
        const bar = $('humedad-bar');
        bar.style.width = `${humedadSuelo ?? 0}%`;
        bar.className = (humedadSuelo <= 40)
            ? 'progress-bar bg-danger progress-bar-striped progress-bar-animated'
            : 'progress-bar bg-success progress-bar-striped progress-bar-animated';

        $('humedad-ambiente-val').innerText = humedadAmbiente ?? '--';
        $('temperatura-val').innerText = temperatura ?? '--';
        if ($('flujo-val')) $('flujo-val').innerText = flujoAgua != null ? flujoAgua.toFixed(2) : '--';

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

        const valoresHumedadSuelo = lecturas.map(l => l.humedad_suelo);
        const valoresTemperatura = lecturas.map(l => l.temperatura);

        const ctx = $('humedadChart');
        if (humedadChart) humedadChart.destroy();

        humedadChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: etiquetas,
                datasets: [
                    {
                        label: 'Humedad Suelo (%)',
                        data: valoresHumedadSuelo,
                        tension: 0.3,
                        borderColor: '#198754',
                        backgroundColor: 'rgba(25,135,84,0.1)',
                        borderWidth: 2,
                        pointRadius: 3,
                        fill: true
                    },
                    {
                        label: 'Temperatura (°C)',
                        data: valoresTemperatura,
                        tension: 0.3,
                        borderColor: '#dc3545',
                        backgroundColor: 'rgba(220,53,69,0.1)',
                        borderWidth: 2,
                        pointRadius: 3
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    y: { beginAtZero: true, max: 100, title: { display: true, text: 'Valores' } },
                    x: { title: { display: true, text: 'Tiempo' } }
                },
                plugins: { legend: { display: true } }
            }
        });
    }

    function actualizarTabla(lecturas) {
        const tabla = $('tablaLecturas');
        tabla.innerHTML = '';

        if (lecturas.length === 0) {
            tabla.innerHTML = '<tr><td colspan="6" class="text-muted">No hay lecturas registradas en este período.</td></tr>';
            return;
        }

        lecturas.slice().reverse().forEach(l => {
            const fechaHora = new Date(l.fechaRegistro).toLocaleString('es-PE', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
            const encendida = !!l.bombaActiva;
            const clase = encendida ? 'text-success' : 'text-secondary';
            const estado = encendida ? 'ENCENDIDA' : 'APAGADA';

            tabla.innerHTML += `
                <tr>
                    <td>${fechaHora}</td>
                    <td><strong>${l.humedad_suelo}%</strong></td>
                    <td>${l.humedad_ambiente != null ? l.humedad_ambiente + '%' : '--'}</td>
                    <td>${l.temperatura != null ? l.temperatura + '°C' : '--'}</td>
                    <td>${l.flujoAgua != null ? l.flujoAgua.toFixed(2) + ' L/min' : '--'}</td>
                    <td class="${clase} fw-bold">${estado}</td>
                </tr>`;
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

    obtenerEstado();
    obtenerEstadoManual();
    obtenerLecturasHistoricas();

    setInterval(obtenerEstado, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerEstadoManual, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerLecturasHistoricas, CONFIG.POLL_LECTURAS_MS);
})();