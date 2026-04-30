(function () {
  'use strict';

  var hostname = window.location.hostname;
  var port = window.location.port;

  var PRODUCTION_HOSTS = ['www.aixfuture.top', 'aixfuture.top'];
  var UAT_HOSTS = ['aixfuture.vercel.app'];
  var DEV_HOSTS = ['localhost', '127.0.0.1'];

  var DEV_API = 'https://aixfutureapi.vercel.app';
  var UAT_API = 'https://aixfutureapi.vercel.app';
  var PROD_API = 'https://www.aixfutrueapi.top';

  var env = 'production';
  var apiBase = PROD_API;

  if (DEV_HOSTS.indexOf(hostname) !== -1) {
    env = 'development';
    apiBase = DEV_API;
  } else if (UAT_HOSTS.indexOf(hostname) !== -1) {
    env = 'uat';
    apiBase = UAT_API;
  } else if (PRODUCTION_HOSTS.indexOf(hostname) !== -1) {
    env = 'production';
    apiBase = PROD_API;
  } else {
    env = 'unknown';
    apiBase = PROD_API;
    console.warn('[AIX][CONFIG] Unknown hostname: ' + hostname + ', falling back to production');
  }

  window.AIX_CONFIG = {
    env: env,
    apiBase: apiBase,
    isDev: env === 'development',
    isUat: env === 'uat',
    isProd: env === 'production'
  };

  console.log('[AIX][CONFIG] env=' + env + ', apiBase="' + apiBase + '", hostname=' + hostname + ', port=' + port);
})();
