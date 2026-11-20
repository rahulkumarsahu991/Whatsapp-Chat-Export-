// Where the WhatsApp server runs.
//  • Opened from the PC app (localhost) or from the cloud server itself → '' (the same site).
//  • Opened from GitHub Pages → the cloud server address below. Put your server's URL here
//    after deploying it (see "Deploy online" in README.md), e.g. 'https://your-name-whatsapp.hf.space'.
window.EXPORTER_CLOUD_URL = 'https://rahul-genai-whatsapp-session-server.hf.space';

window.EXPORTER_API = location.hostname.endsWith('github.io') ? window.EXPORTER_CLOUD_URL : '';

// For testing another server from this page: localStorage.setItem('exporterApi', 'https://…') (remove to undo).
try { const o = localStorage.getItem('exporterApi'); if (o !== null) window.EXPORTER_API = o; } catch (e) { /* storage blocked */ }
