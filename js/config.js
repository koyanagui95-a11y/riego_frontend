const CONFIG = {
    API_URL: (() => {
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host === '127.0.0.2') {
            return 'http://localhost:8080/api';
        }
        return 'https://riego-back-kzob.onrender.com/api';
    })(),
    POLL_ESTADO_MS: 2000,
    POLL_LECTURAS_MS: 10000
};
