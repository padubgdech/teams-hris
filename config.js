/**
 * Teams HRIS — Configuration
 *
 * API_BASE — which backend this page talks to:
 *   • Served by a Render service (production OR staging) or localhost → use that same server.
 *     This keeps staging fully separate: a staging page can never write to production data.
 *   • Served from anywhere else (e.g. GitHub Pages) → use the production backend.
 *
 * GOOGLE_CLIENT_ID — from Google Cloud Console → APIs & Services → Credentials (OAuth 2.0 Client ID).
 *   Each site URL must be listed under "Authorized JavaScript origins".
 */
(function () {
  var PROD_API = 'https://teams-hris.onrender.com';
  var h = location.hostname;
  var sameOrigin = /\.onrender\.com$/.test(h) || h === 'localhost' || h === '127.0.0.1';
  window.HRIS_API_BASE = sameOrigin ? location.origin : PROD_API;
  window.HRIS_ENV = /staging/.test(h) ? 'staging' : (h === 'localhost' || h === '127.0.0.1') ? 'local' : 'production';
})();
window.HRIS_GOOGLE_CLIENT_ID = '261071644785-4a5jlonrubqang0ppn1bq05upc1g4tvt.apps.googleusercontent.com';
