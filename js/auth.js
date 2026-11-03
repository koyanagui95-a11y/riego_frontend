(function () {
    const ALERT = document.getElementById('alert');

    function showAlert(message, type = 'danger') {
        if (!ALERT) return;
        ALERT.className = `alert alert-${type}`;
        ALERT.textContent = message;
        ALERT.classList.remove('d-none');
    }

    function hideAlert() {
        if (ALERT) ALERT.classList.add('d-none');
    }

    function setLoading(btn, spinner, loading) {
        if (!btn || !spinner) return;
        btn.disabled = loading;
        spinner.classList.toggle('d-none', !loading);
    }

    function redirectIfLogged() {
        if (localStorage.getItem('userId')) {
            window.location.replace('index.html');
        }
    }

    function bindToggles() {
        document.querySelectorAll('[data-toggle]').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.toggle);
                const icon = btn.querySelector('i');
                const isPass = input.type === 'password';
                input.type = isPass ? 'text' : 'password';
                icon.className = isPass ? 'bi bi-eye-slash' : 'bi bi-eye';
            });
        });
    }

    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        redirectIfLogged();
        bindToggles();

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAlert();

            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            const btn = document.getElementById('btnLogin');
            const spinner = document.getElementById('spinner');

            if (username.length < 4) return showAlert('El usuario debe tener al menos 4 caracteres.', 'warning');
            if (password.length < 8) return showAlert('La contraseña debe tener al menos 8 caracteres.', 'warning');

            setLoading(btn, spinner, true);
            try {
                const res = await fetch(`${CONFIG.API_URL}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.id) throw new Error(data.username || 'Credenciales inválidas.');

                localStorage.setItem('userId', data.id);
                localStorage.setItem('username', data.username);
                window.location.replace('index.html');
            } catch (err) {
                showAlert(err.message || 'No se pudo iniciar sesión.', 'danger');
            } finally {
                setLoading(btn, spinner, false);
            }
        });
    }

    const changeForm = document.getElementById('changeForm');
    if (changeForm) {
        const storedUser = localStorage.getItem('username');
        if (storedUser) document.getElementById('username').value = storedUser;
        bindToggles();

        changeForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAlert();

            const username = document.getElementById('username').value.trim();
            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const btn = document.getElementById('btnChange');
            const spinner = document.getElementById('spinner');

            if (username.length < 4) return showAlert('Usuario inválido.', 'warning');
            if (currentPassword.length < 8) return showAlert('Contraseña actual inválida.', 'warning');
            if (newPassword.length < 8) return showAlert('La nueva contraseña debe tener al menos 8 caracteres.', 'warning');
            if (newPassword !== confirmPassword) return showAlert('Las contraseñas no coinciden.', 'warning');
            if (newPassword === currentPassword) return showAlert('La nueva contraseña debe ser distinta a la actual.', 'warning');

            setLoading(btn, spinner, true);
            try {
                const res = await fetch(`${CONFIG.API_URL}/auth/change-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, currentPassword, newPassword })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.id) throw new Error(data.username || 'No se pudo cambiar la contraseña.');

                showAlert('Contraseña actualizada. Ya puedes iniciar sesión.', 'success');
                changeForm.reset();
                setTimeout(() => window.location.replace('login.html'), 1500);
            } catch (err) {
                showAlert(err.message || 'Error al cambiar la contraseña.', 'danger');
            } finally {
                setLoading(btn, spinner, false);
            }
        });
    }

    const forgotForm = document.getElementById('forgotForm');
    if (forgotForm) {
        forgotForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAlert();

            const email = document.getElementById('email').value.trim();
            const btn = document.getElementById('btnForgot');
            const spinner = document.getElementById('spinner');

            if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email)) {
                return showAlert('Ingresa un correo @gmail.com válido.', 'warning');
            }

            setLoading(btn, spinner, true);
            try {
                const res = await fetch(`${CONFIG.API_URL}/auth/forgot-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.mensaje || 'No se pudo procesar la solicitud.');

                showAlert('Si el correo está registrado, recibirás un enlace de recuperación.', 'success');
                forgotForm.reset();
            } catch (err) {
                showAlert(err.message || 'Error de red.', 'danger');
            } finally {
                setLoading(btn, spinner, false);
            }
        });
    }

    const resetForm = document.getElementById('resetForm');
    if (resetForm) {
        const token = new URLSearchParams(window.location.search).get('token');
        if (!token) {
            showAlert('Enlace inválido. Solicita uno nuevo.', 'danger');
            document.getElementById('btnReset').disabled = true;
            return;
        }
        document.getElementById('token').value = token;
        bindToggles();

        resetForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAlert();

            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const btn = document.getElementById('btnReset');
            const spinner = document.getElementById('spinner');

            if (newPassword.length < 8) return showAlert('La contraseña debe tener al menos 8 caracteres.', 'warning');
            if (newPassword !== confirmPassword) return showAlert('Las contraseñas no coinciden.', 'warning');

            setLoading(btn, spinner, true);
            try {
                const res = await fetch(`${CONFIG.API_URL}/auth/reset-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, newPassword })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.mensaje || 'No se pudo restablecer la contraseña.');

                showAlert('Contraseña restablecida. Ya puedes iniciar sesión.', 'success');
                resetForm.reset();
                setTimeout(() => window.location.replace('login.html'), 1500);
            } catch (err) {
                showAlert(err.message || 'Error al restablecer la contraseña.', 'danger');
            } finally {
                setLoading(btn, spinner, false);
            }
        });
    }
})();