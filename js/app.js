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
            obtenerLecturasDelDia();
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
                const badge = $('bomba-status');
                badge.className = 'badge rounded-pill bg-secondary px-4 py-2 fs-5';
                badge.innerHTML = '<i class="bi bi-power me-1"></i> APAGADO';
                $('bomba-texto').innerText = 'Sistema Apagado / Sin datos.';
                $('humedad-val').innerText = '--';
                $('humedad-bar').style.width = '0%';
                $('humedad-ambiente-val').innerText = '--';
                $('temperatura-val').innerText = '--';
                $('fecha-val').innerText = '--';
                return;
            }
            actualizarInterfaz(await res.json());
        } catch (err) {
            console.error(err);
            const badge = $('bomba-status');
            badge.className = 'badge rounded-pill bg-secondary px-4 py-2 fs-5';
            badge.innerHTML = '<i class="bi bi-power me-1"></i> APAGADO';
            $('bomba-texto').innerText = 'Sistema Apagado / Sin conexión.';
            $('humedad-val').innerText = '--';
            $('humedad-bar').style.width = '0%';
            $('humedad-ambiente-val').innerText = '--';
            $('temperatura-val').innerText = '--';
            $('fecha-val').innerText = '--';
        }
    }

    function actualizarInterfaz(data) {
        if (data.mensaje) {
            const badge = $('bomba-status');
            badge.className = 'badge rounded-pill bg-secondary px-4 py-2 fs-5';
            badge.innerHTML = '<i class="bi bi-power me-1"></i> APAGADO';
            $('bomba-texto').innerText = 'Sistema Apagado / Esperando primera lectura.';
            $('humedad-val').innerText = '--';
            $('humedad-bar').style.width = '0%';
            $('humedad-ambiente-val').innerText = '--';
            $('temperatura-val').innerText = '--';
            $('fecha-val').innerText = '--';
            return;
        }

        const humedadSuelo = data.humedad_suelo;
        const humedadAmbiente = data.humedad_ambiente;
        const temperatura = data.temperatura;

        $('humedad-val').innerText = humedadSuelo ?? '--';
        const bar = $('humedad-bar');
        bar.style.width = `${humedadSuelo ?? 0}%`;
        bar.className = (humedadSuelo <= 40)
            ? 'progress-bar bg-danger progress-bar-striped progress-bar-animated'
            : 'progress-bar bg-success progress-bar-striped progress-bar-animated';

        $('humedad-ambiente-val').innerText = humedadAmbiente ?? '--';
        $('temperatura-val').innerText = temperatura ?? '--';

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

    async function obtenerLecturasDelDia() {
        try {
            const res = await safeFetch(
                `${CONFIG.API_URL}/v1/lecturas/usuario/${usuarioId}?page=0&size=200&sort=fechaRegistro,desc`
            );
            if (!res.ok) throw new Error('No se pudieron obtener las lecturas');

            const page = await res.json();
            const lecturas = Array.isArray(page) ? page : (page.content || []);

            const hoy = new Date();
            const lecturasHoy = lecturas
                .filter(l => l.fechaRegistro && esMismoDia(new Date(l.fechaRegistro), hoy))
                .sort((a, b) => new Date(a.fechaRegistro) - new Date(b.fechaRegistro));

            actualizarGrafico(lecturasHoy);
            actualizarTabla(lecturasHoy);
            $('fecha-dashboard').innerText = hoy.toLocaleDateString('es-PE');
        } catch (err) {
            console.error('Error cargando dashboard:', err);
        }
    }

    function esMismoDia(a, b) {
        return a.getFullYear() === b.getFullYear()
            && a.getMonth() === b.getMonth()
            && a.getDate() === b.getDate();
    }

    function actualizarGrafico(lecturas) {
        const etiquetas = lecturas.map(l => new Date(l.fechaRegistro).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }));
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
                    x: { title: { display: true, text: 'Hora' } }
                },
                plugins: { legend: { display: true } }
            }
        });
    }

    function actualizarTabla(lecturas) {
        const tabla = $('tablaLecturas');
        tabla.innerHTML = '';

        if (lecturas.length === 0) {
            tabla.innerHTML = '<tr><td colspan="5" class="text-muted">No hay lecturas registradas hoy.</td></tr>';
            return;
        }

        lecturas.slice().reverse().forEach(l => {
            const hora = new Date(l.fechaRegistro).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
            const encendida = !!l.bombaActiva;
            const clase = encendida ? 'text-success' : 'text-secondary';
            const estado = encendida ? 'ENCENDIDA' : 'APAGADA';

            tabla.innerHTML += `
                <tr>
                    <td>${hora}</td>
                    <td><strong>${l.humedad_suelo}%</strong></td>
                    <td>${l.humedad_ambiente != null ? l.humedad_ambiente + '%' : '--'}</td>
                    <td>${l.temperatura != null ? l.temperatura + '°C' : '--'}</td>
                    <td class="${clase} fw-bold">${estado}</td>
                </tr>`;
        });
    }

    document.getElementById('btnBombaManual').addEventListener('click', cambiarBombaManual);

    obtenerEstado();
    obtenerEstadoManual();
    obtenerLecturasDelDia();

    setInterval(obtenerEstado, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerEstadoManual, CONFIG.POLL_ESTADO_MS);
    setInterval(obtenerLecturasDelDia, CONFIG.POLL_LECTURAS_MS);
})();