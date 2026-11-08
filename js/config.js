const CONFIG = {
    API_URL: (() => {
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.2') {
            return 'http://localhost:8080/api';
        }
        return 'https://riego-backend-nh43.onrender.com/api';
    })(),
    POLL_ESTADO_MS: 10000,
    POLL_LECTURAS_MS: 10000,
};