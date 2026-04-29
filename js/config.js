(function () {
  'use strict';

  var hostname = window.location.hostname;

  var PRODUCTION_HOSTS = ['www.aixfuture.top', 'aixfuture.top'];
  var UAT_HOSTS = ['aixfuture.vercel.app'];
  var DEV_HOSTS = ['localhost', '127.0.0.1'];

  var env = 'production';
  var apiBase = '';

  if (DEV_HOSTS.indexOf(hostname) !== -1) {
    env = 'development';
    apiBase = 'https://aixfutureapi.vercel.app';
  } else if (UAT_HOSTS.indexOf(hostname) !== -1) {
    env = 'uat';
    apiBase = 'https://aixfutureapi.vercel.app';
  } else if (PRODUCTION_HOSTS.indexOf(hostname) !== -1) {
    env = 'production';
    apiBase = '';
  } else {
    env = 'unknown';
    apiBase = '';
    console.warn('[AIX][CONFIG] Unknown hostname: ' + hostname + ', falling back to production');
  }

  window.AIX_CONFIG = {
    env: env,
    apiBase: apiBase
  };

  console.log('[AIX][CONFIG] env=' + env + ', apiBase="' + apiBase + '", hostname=' + hostname);
})();
