/*
 * ac-playtest — independently written stand-in for the AirConsole JS API (airconsole-<version>.js); it contains
 * no AirConsole code. Behaviour follows the public API reference and the observed behaviour of the 1.11 library.
 *
 * The ac-playtest server serves this file in place of https://www.airconsole.com/api/airconsole-<version>.js.
 * Like the real library it is a thin client: it keeps its own copy of the device list and talks to its parent
 * window (the simulated platform, sim.html) with window.postMessage, using the same message shapes:
 *   up:   {action: 'ready' | 'message' | 'set' | 'event' | 'jserror', ...}
 *   down: {action: 'ready' | 'message' | 'update' | 'ad' | 'pause' | 'resume' | 'premium' | 'profile' | ...}
 * Connect / disconnect, custom state, active players and player silencing are derived here, on the client,
 * from 'update' messages, the way the documented 1.11 API behaves. See README.md, "Fidelity".
 *
 * Unofficial; not affiliated with or endorsed by AirConsole / N-Dream AG.
 */
(function () {
  'use strict';

  var IMPLEMENTED_VERSION = '1.11.0';
  var script = document.currentScript;
  var tag = script && /airconsole-([\w.-]+?)\.js(?:[?#]|$)/.exec(script.src);
  var tagVersion = tag ? tag[1] : IMPLEMENTED_VERSION;
  // Like the real library: player silencing is on by default unless the game loads airconsole-latest.js.
  var DEFAULT_SILENCING = tagVersion !== 'latest';
  var VERSION = /^\d+\.\d+\.\d+$/.test(tagVersion) ? tagVersion : IMPLEMENTED_VERSION;

  var SCREEN = 0;
  var MEDIA_TIMEOUT_MS = 45000;
  var internals = new WeakMap(); // AirConsole instance -> private state (kept off the object so JSON stays clean)

  function post(data) {
    try {
      window.parent.postMessage(data, '*');
    } catch (e) {
      // Same as the real library: a non-cloneable payload is logged, not thrown.
      console.log('Posting message to parent failed: ' + JSON.stringify(data));
    }
  }

  function set(key, value) {
    post({ action: 'set', key: key, value: value });
  }

  // The "game url" of a location: without query / hash / screen.html / controller.html, https folded to http.
  // Devices whose location maps to the same game url as this frame count as "connected" to this game.
  function gameUrl(url) {
    if (!url) return undefined;
    url = url.split('#')[0].split('?')[0].replace(/(screen|controller)\.html$/, '');
    return url.indexOf('https://') === 0 ? 'http://' + url.slice(8) : url;
  }

  function UserMediaError(message) {
    var e = new Error(message);
    e.name = 'AirConsole.UserMediaError';
    return e;
  }

  function AirConsole(opts) {
    if (window.parent === window) {
      console.error('The AirConsole API is used outside of the AirConsole platform. ' +
        '(ac-playtest: open the sim page, /__ac/sim.html, instead of this file.)');
    }
    opts = opts || {};
    var self = this;
    this.version = VERSION;
    this.devices = [];
    this.server_time_offset = opts.synchronize_time ? 0 : false;
    this.silence_inactive_players = opts.silence_inactive_players !== undefined
      ? opts.silence_inactive_players : DEFAULT_SILENCING;
    this.supportsNativeGameSizing = !!opts.supportsNativeGameSizing;
    // device_id, translations, gameSafeArea and gameConfiguration are deliberately NOT initialised: they stay
    // undefined until the platform's ready message provides them. A JSON null in their place crashes engine
    // bridges that cast them (e.g. the Unity plugin's onReady payload).
    var state = {
      silencedQueue: {},        // device id -> queued 'update' payloads of a silenced device
      playerCache: null,        // device id -> player number
      media: null,              // pending getUserMedia {resolve, reject, timer, constraints}
      listener: function (event) {
        if (event.source === window.parent) receive(self, event.data);
      }
    };
    internals.set(this, state);
    window.addEventListener('message', state.listener, false);
    set('orientation', opts.orientation);
    if (opts.setup_document !== false) setupDocument();
    post({
      action: 'ready',
      version: VERSION,
      device_motion: opts.device_motion,
      synchronize_time: opts.synchronize_time,
      silencePlayers: this.silence_inactive_players,
      supportsNativeGameSizing: this.supportsNativeGameSizing,
      location: document.location.href,
      translation: opts.translation
    });
  }

  AirConsole.SCREEN = SCREEN;
  AirConsole.ORIENTATION_PORTRAIT = 'portrait';
  AirConsole.ORIENTATION_LANDSCAPE = 'landscape';
  AirConsole.VIBRATE = {
    TYPE: { COMPOSITION: 'composition' },
    PRIMITIVE: {
      CLICK: 'primitiveClick', THUD: 'primitiveThud', SPIN: 'primitiveSpin', QUICK_RISE: 'primitiveQuickRise',
      SLOW_RISE: 'primitiveSlowRise', QUICK_FALL: 'primitiveQuickFall', TICK: 'primitiveTick', LOW_TICK: 'primitiveLowTick'
    }
  };
  AirConsole.USER_MEDIA_ERROR_TYPE = {
    notSupportedOnScreen: 'NotSupportedOnScreen', notReady: 'NotReady', alreadyPending: 'AlreadyPending',
    invalidConstraints: 'InvalidConstraints', timeout: 'Timeout', permissionDenied: 'PermissionDenied'
  };

  var P = AirConsole.prototype;

  // ---- abstract callbacks (games overwrite these)
  var CALLBACKS = ['onReady', 'onConnect', 'onDisconnect', 'onMessage', 'onDeviceStateChange',
    'onCustomDeviceStateChange', 'onDeviceProfileChange', 'onEmailAddress', 'onActivePlayersChange', 'onDeviceMotion',
    'onAdShow', 'onAdComplete', 'onPremium', 'onPersistentDataLoaded', 'onPersistentDataStored', 'onHighScores',
    'onHighScoreStored', 'onPause', 'onResume', 'onSetSafeArea', 'onUserMediaAccessGranted', 'onUserMediaAccessDenied'];
  CALLBACKS.forEach(function (name) { P[name] = function () {}; });

  // ---- connectivity
  P.getDeviceId = function () { return this.device_id; };

  P.getControllerDeviceIds = function () {
    var own = gameUrl(document.location.href);
    var ids = [];
    for (var i = SCREEN + 1; i < this.devices.length; i++) {
      if (this.devices[i] && gameUrl(this.devices[i].location) === own) ids.push(i);
    }
    return ids;
  };

  // Premium devices first, then the lowest connected controller id.
  P.getMasterControllerDeviceId = function () {
    var premium = this.getPremiumDeviceIds();
    return premium.length ? premium[0] : this.getControllerDeviceIds()[0];
  };

  P.getServerTime = function () {
    if (this.server_time_offset === false) {
      throw 'AirConsole constructor was not called with {synchronize_time: true}';
    }
    return Date.now() + this.server_time_offset;
  };

  P.arePlayersSilenced = function () {
    var screen = this.devices[SCREEN];
    if (!screen) return false;
    var screenSilences = !!screen.silencePlayers;
    return (!!this.silence_inactive_players || screenSilences) && !!screen.players && screen.players.length > 0;
  };

  P.getGameConfiguration = function () {
    if (this.device_id === undefined) throw 'getGameConfiguration is available only after onReady.';
    return this.device_id === SCREEN ? (this.gameConfiguration || {}) : {};
  };

  // ---- messaging
  P.message = function (device_id, data) {
    if (this.device_id !== undefined && !isSilenced(this, device_id)) {
      post({ action: 'message', to: device_id, data: data });
    }
  };

  P.broadcast = function (data) { this.message(undefined, data); };

  // ---- device states
  P.getCustomDeviceState = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var d = this.devices[device_id];
    if (d && gameUrl(d.location) === gameUrl(document.location.href)) return d.custom;
  };

  P.setCustomDeviceState = function (data) {
    if (this.device_id !== undefined) {
      this.devices[this.device_id].custom = data;
      set('custom', data);
    }
  };

  P.setCustomDeviceStateProperty = function (key, value) {
    if (this.device_id === undefined) return;
    var state = this.getCustomDeviceState();
    if (state === undefined) state = {};
    else if (typeof state !== 'object') throw 'Custom DeviceState needs to be of type object';
    state[key] = value;
    this.setCustomDeviceState(state);
  };

  P.setImmersiveState = function (immersiveState) {
    if (this.device_id !== SCREEN) throw 'Only the screen can set the immersive state.';
    if (!immersiveState || typeof immersiveState !== 'object') return;
    if (immersiveState.light === undefined && immersiveState.climate === undefined &&
        immersiveState.experiment === undefined) return;
    set('immersive', immersiveState);
  };

  // ---- profile
  P.getUID = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var d = this.devices[device_id];
    if (d) return d.uid;
  };

  P.getNickname = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var d = this.devices[device_id];
    if (d) return d.nickname || ('Guest ' + device_id);
  };

  // Offline: pictures come from the local server (generated avatar), not from airconsole.com.
  P.getProfilePicture = function (device_id_or_uid, size) {
    var base = document.location.origin + '/__ac/profile-picture?size=' + (size || 64) + '&uid=';
    if (device_id_or_uid === undefined) device_id_or_uid = this.device_id;
    else if (typeof device_id_or_uid === 'string') return base + encodeURIComponent(device_id_or_uid);
    var d = this.devices[device_id_or_uid];
    if (d) return base + encodeURIComponent(d.uid) + (d.picture ? '&v=' + d.picture : '');
  };

  P.isUserLoggedIn = function (device_id) {
    if (device_id == undefined) device_id = this.device_id;
    var d = this.devices[device_id];
    if (d) return d.auth;
  };

  P.requestEmailAddress = function () { set('email', true); };
  P.editProfile = function () { set('login', true); };

  // ---- active players
  P.setActivePlayers = function (max_players) {
    if (this.getDeviceId() !== SCREEN) throw 'Only the AirConsole.SCREEN can set the active players!';
    var state = internals.get(this);
    state.playerCache = null;
    var players = this.getControllerDeviceIds();
    if (max_players !== undefined) players = players.slice(0, Math.min(players.length, max_players));
    this.devices[SCREEN].players = players;
    set('players', players);
    if (max_players === 0) {
      // End of a round: replay the updates of devices that were silenced, in order.
      var queued = state.silencedQueue;
      state.silencedQueue = {};
      for (var id in queued) {
        for (var i = 0; i < queued[id].length; i++) receive(this, queued[id][i]);
      }
    }
  };

  P.getActivePlayerDeviceIds = function () {
    return this.devices[SCREEN].players || [];
  };

  P.convertPlayerNumberToDeviceId = function (player_number) {
    return this.getActivePlayerDeviceIds()[player_number];
  };

  P.convertDeviceIdToPlayerNumber = function (device_id) {
    var screen = this.devices[SCREEN];
    if (!screen || !screen.players) return;
    var state = internals.get(this);
    if (!state.playerCache) {
      state.playerCache = {};
      for (var i = 0; i < screen.players.length; i++) state.playerCache[screen.players[i]] = i;
    }
    return state.playerCache[device_id];
  };

  // ---- controller inputs
  P.vibrate = function (options) { set('vibrate', options); };

  // getUserMedia: argument checks as documented; the platform always denies a valid request (no microphone).
  P.getUserMedia = function (constraints) {
    var T = AirConsole.USER_MEDIA_ERROR_TYPE;
    var state = internals.get(this);
    if (this.device_id === SCREEN) return Promise.reject(UserMediaError(T.notSupportedOnScreen));
    if (this.device_id === undefined) return Promise.reject(UserMediaError(T.notReady));
    if (state.media) return Promise.reject(UserMediaError(T.alreadyPending));
    if (!constraints || !constraints.audio || constraints.video) return Promise.reject(UserMediaError(T.invalidConstraints));
    return new Promise(function (resolve, reject) {
      state.media = {
        resolve: resolve, reject: reject, constraints: constraints,
        timer: setTimeout(function () { settleMedia(state, UserMediaError(T.timeout)); }, MEDIA_TIMEOUT_MS)
      };
      post({ action: 'event', type: 'requestUserMediaPermission', data: { constraints: constraints } });
    });
  };

  P.destroy = function () {
    var state = internals.get(this);
    window.removeEventListener('message', state.listener);
    if (state.media) settleMedia(state, UserMediaError(AirConsole.USER_MEDIA_ERROR_TYPE.timeout));
  };

  // ---- ads
  P.showAd = function () {
    if (this.device_id != SCREEN) throw 'Only the AirConsole.SCREEN can call showAd!';
    set('ad', true);
  };

  // ---- premium
  P.isPremium = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var d = this.devices[device_id];
    if (d && device_id != SCREEN) return !!d.premium;
  };

  P.getPremiumDeviceIds = function () {
    var ids = [];
    for (var i = 1; i < this.devices.length; i++) if (this.isPremium(i)) ids.push(i);
    return ids;
  };

  P.getPremium = function () { set('premium', true); };

  // ---- navigation (the platform records these; nothing is navigated)
  P.navigateHome = function () { set('home', true); };

  P.navigateTo = function (url, parameters) {
    if (url.indexOf('.') === 0) {
      var path = document.location.href.split('#')[0].split('/');
      path.pop();
      url.split('/').forEach(function (part) {
        if (part === '..') path.pop();
        else if (part !== '.' && part !== '') path.push(part);
      });
      url = path.join('/') + '/';
    }
    if (parameters) url += '#' + encodeURIComponent(JSON.stringify(parameters));
    set('home', url);
  };

  P.getNavigateParameters = function () {
    var state = internals.get(this);
    if (state.navigateParameters === undefined && document.location.hash.length > 1) {
      state.navigateParameters = JSON.parse(decodeURIComponent(document.location.hash.slice(1)));
    }
    return state.navigateParameters;
  };

  P.openExternalUrl = function (url) { set('pass_external_url', url); };

  // ---- user interface
  P.setOrientation = function (orientation) { set('orientation', orientation); };

  // ---- persistent data
  P.requestPersistentData = function (uids) {
    if (this.device_id === SCREEN) {
      if (!uids) throw new Error('A valid array of uids must be provided on the screen');
      if (uids.length < 1) throw new Error('At least one valid uid must be provided on the screen');
    } else {
      uids = uids || [];
      uids.push(this.getUID());
    }
    set('persistentrequest', { uids: uids });
  };

  P.storePersistentData = function (key, value, uid) {
    if (this.device_id === SCREEN) {
      if (!uid) throw new Error('A valid uid must be provided on the screen');
    } else {
      uid = this.getUID();
    }
    set('persistentstore', { key: key, value: value, uid: uid });
  };

  // ---- high scores
  P.storeHighScore = function (level_name, level_version, score, uid, data, score_string) {
    if (typeof score !== 'number' || isNaN(score)) throw 'Score needs to be a number and not NaN!';
    if (!uid) uid = this.getUID();
    if (Array.isArray(uid)) uid = uid.join('|');
    set('highscore', {
      uid: uid, level_name: level_name, level_version: level_version, score: score, data: data,
      score_string: score_string
    });
  };

  P.requestHighScores = function (level_name, level_version, uids, ranks, total, top) {
    var self = this;
    if (!uids) uids = this.getControllerDeviceIds().map(function (id) { return self.getUID(id); });
    set('highscores', {
      level_name: level_name, level_version: level_version, uids: uids, ranks: ranks || ['world'],
      total: total == undefined ? 8 : total, top: top == undefined ? 5 : top
    });
  };

  // ---- translations
  P.getTranslation = function (id, values) {
    if (!this.translations || !this.translations[id]) return;
    var text = this.translations[id];
    if (!values) return text;
    // "Hi %name%" + {name: 'Tom'} -> "Hi Tom"; "%%" -> "%"
    return text.split('%').map(function (part, i) {
      if (i % 2 === 0) return part;
      return part.length ? (values[part] || '') : '%';
    }).join('');
  };

  P.getLanguage = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var d = this.devices[device_id];
    if (d) return d.language;
  };

  // ---- incoming messages from the platform

  function isSilenced(api, device_id) {
    return api.arePlayersSilenced() && device_id !== undefined && device_id !== null && device_id !== SCREEN &&
      api.convertDeviceIdToPlayerNumber(device_id) === undefined;
  }

  function inThisGame(api, device_id, own) {
    var d = api.devices[device_id];
    return !!d && gameUrl(d.location) === own;
  }

  function receive(api, data) {
    if (!data || typeof data !== 'object') return;
    var own = gameUrl(document.location.href);
    switch (data.action) {
      case 'ready': onReadyMessage(api, data, own); break;
      case 'update': onUpdateMessage(api, data, own); break;
      case 'message':
        if (api.device_id !== undefined && inThisGame(api, data.from, own) &&
            !isSilenced(api, data.from) && !isSilenced(api, data.to)) {
          api.onMessage(data.from, data.data);
        }
        break;
      case 'profile':
        if (api.device_id) {
          var me = api.devices[api.device_id];
          me.auth = data.auth;
          me.nickname = data.nickname;
          me.picture = data.picture;
          api.onDeviceStateChange(api.device_id, me);
          api.onDeviceProfileChange(api.device_id);
        }
        break;
      case 'email': api.onEmailAddress(data.email); break;
      case 'ad':
        if (data.complete === undefined) api.onAdShow();
        else api.onAdComplete(data.complete);
        break;
      case 'highscores': api.onHighScores(data.highscores); break;
      case 'highscore': api.onHighScoreStored(data.highscore); break;
      case 'persistentstore': api.onPersistentDataStored(data.uid); break;
      case 'persistentrequest': api.onPersistentDataLoaded(data.data); break;
      case 'premium':
        if (api.devices[data.device_id]) api.devices[data.device_id].premium = true;
        api.onPremium(data.device_id);
        break;
      case 'pause': api.onPause(); break;
      case 'resume': api.onResume(); break;
      case 'device_motion': api.onDeviceMotion(data.data); break;
      case 'setGameSafeArea':
        api.gameSafeArea = data.gameSafeArea;
        api.onSetSafeArea(data.gameSafeArea);
        break;
      case 'event': onPlatformEvent(api, data); break;
    }
  }

  function onReadyMessage(api, data, own) {
    var state = internals.get(api);
    api.device_id = data.device_id;
    api.devices = data.devices;
    if (api.server_time_offset !== false) api.server_time_offset = data.server_time_offset || 0;
    api.gameSafeArea = data.gameSafeArea;
    api.gameConfiguration = data.gameConfiguration;
    if (data.translations) {
      api.translations = data.translations;
      var nodes = document.querySelectorAll('[data-translation]');
      for (var n = 0; n < nodes.length; n++) {
        nodes[n].innerHTML = api.getTranslation(nodes[n].getAttribute('data-translation'));
      }
    }
    api.onReady(data.code);
    // Devices that already run this game are announced right after onReady.
    for (var i = 0; i < api.devices.length; i++) {
      if (!inThisGame(api, i, own)) continue;
      if (i !== api.device_id) {
        api.onConnect(i);
        var custom = api.getCustomDeviceState(i);
        if (custom !== undefined) api.onCustomDeviceStateChange(i, custom);
        if (i === SCREEN && api.devices[i].players) {
          state.playerCache = null;
          api.onActivePlayersChange(api.convertDeviceIdToPlayerNumber(api.device_id));
        }
      }
      if (api.isPremium(i)) api.onPremium(i);
    }
    if (data.gameSafeArea) api.onSetSafeArea(data.gameSafeArea);
  }

  function onUpdateMessage(api, data, own) {
    if (api.device_id === undefined) return;
    var state = internals.get(api);
    var id = data.device_id;
    var before = api.devices[id];
    var after = data.device_data;
    var urlBefore = before ? gameUrl(before.location) : null;
    var urlAfter = after ? gameUrl(after.location) : null;
    var loaded = urlBefore !== own && urlAfter === own;
    var unloaded = urlBefore === own && urlAfter !== own;

    if (isSilenced(api, id)) {
      // Silenced device: hold its updates until the round ends (setActivePlayers(0) on the screen).
      // A connect followed by a disconnect cancels out; neither is delivered.
      var queue = state.silencedQueue[id] || [];
      if (unloaded) {
        for (var q = 0; q < queue.length; q++) {
          if (queue[q].__connects) {
            delete state.silencedQueue[id];
            return;
          }
        }
      }
      queue.push(Object.assign({}, data, { __connects: loaded }));
      state.silencedQueue[id] = queue;
      return;
    }

    api.devices[id] = after;
    api.onDeviceStateChange(id, after);
    if (loaded) api.onConnect(id);
    else if (unloaded) api.onDisconnect(id);
    if (!after) return;
    if ((after._is_custom_update && urlAfter === own) || (loaded && after.custom)) {
      api.onCustomDeviceStateChange(id, after.custom);
    }
    if ((after._is_players_update && urlAfter === own) || (id === SCREEN && after.players && loaded)) {
      state.playerCache = null;
      api.onActivePlayersChange(api.convertDeviceIdToPlayerNumber(api.device_id));
    }
    if (after.premium && (after._is_premium_update || loaded)) api.onPremium(id);
    if (after._is_profile_update) api.onDeviceProfileChange(id);
  }

  function settleMedia(state, error) {
    var media = state.media;
    if (!media) return;
    clearTimeout(media.timer);
    state.media = null;
    media.reject(error);
  }

  function onPlatformEvent(api, data) {
    var state = internals.get(api);
    if (state.media && data.type === 'userMediaPermissionDenied') {
      settleMedia(state, UserMediaError(AirConsole.USER_MEDIA_ERROR_TYPE.permissionDenied));
    }
  }

  // No text selection, fixed zoom, no scrolling: what setup_document (default true) asks for.
  function setupDocument() {
    var style = document.createElement('style');
    style.textContent =
      'body { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; ' +
      '-webkit-text-size-adjust: none; -webkit-tap-highlight-color: transparent; }\n' +
      'input, textarea { -webkit-user-select: text; user-select: text; }';
    var meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, minimum-scale=1, initial-scale=1, user-scalable=no';
    var head = document.head || document.getElementsByTagName('head')[0];
    head.appendChild(meta);
    head.appendChild(style);
    document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  }

  // Uncaught errors are reported to the platform, like the real library does.
  function reportError(message, stack, filename, lineno, colno) {
    post({
      action: 'jserror', url: document.location.href,
      exception: { message: message, error: { stack: stack }, filename: filename, lineno: lineno, colno: colno }
    });
  }
  window.addEventListener('error', function (e) {
    reportError(e.message, e.error && e.error.stack, e.filename, e.lineno, e.colno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    reportError('Unhandled promise rejection: ' + e.reason, e.reason && e.reason.stack, 'unhandledrejection', 0);
  });

  window.AirConsole = AirConsole;
})();
