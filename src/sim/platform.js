/*
 * ac-playtest — the simulated AirConsole platform. Runs in the top page (sim.html) and plays the part of the
 * AirConsole web app + servers: it owns the session's device list, hosts the screen frame and one frame per
 * phone, answers each frame's AirConsole API over window.postMessage, routes messages (JSON round-trip, like the
 * network), and implements the platform features (ads, pause/resume, premium, high scores, persistent data).
 *
 * Automation hooks: window.__acPlatform (controls, called by the Node side through page.evaluate) and
 * window.__acPlaytestEmit (a Playwright binding, if present, receiving every recorded event).
 */
(function () {
  'use strict';

  var SCREEN = 0;
  // Games may not go fullscreen: a fullscreen screen frame would cover the phones (Unity WebGL requests it).
  // With 'none', document.fullscreenEnabled is false in the frame and engines skip the request quietly.
  var FRAME_POLICY = "autoplay; fullscreen 'none'";
  var query = new URLSearchParams(location.search);
  var injected = window.__AC_PLAYTEST_CONFIG__ || {};

  function size(text, fallback) {
    var m = /^(\d+)x(\d+)$/.exec(text || '');
    return m ? { width: Number(m[1]), height: Number(m[2]) } : fallback;
  }
  function option(name, fallback) {
    if (injected[name] !== undefined) return injected[name];
    if (!query.has(name)) return fallback;
    var raw = query.get(name);
    if (typeof fallback === 'number') return Number(raw);
    if (typeof fallback === 'boolean') return raw !== '0' && raw !== 'false';
    return raw;
  }

  var config = {
    phones: option('phones', 0),
    code: option('code', '1234 5678'),
    screenSize: injected.screenSize || size(query.get('screen'), { width: 1280, height: 720 }),
    phoneSize: injected.phoneSize || size(query.get('phone'), { width: 360, height: 640 }), // portrait
    scale: option('scale', 0.5),
    adDuration: option('adDuration', 2500),
    adFill: option('adFill', true),
    latency: option('latency', 0),
    language: option('language', 'en'),
    serverTimeOffset: option('serverTimeOffset', 0),
    translations: injected.translations,        // {en: {id: text}, de: {...}}
    gameConfiguration: injected.gameConfiguration,
    gameSafeArea: injected.gameSafeArea,
    persistentData: injected.persistentData || {}, // {uid: {key: value}}
    // The game's folder below the served root ('' or 'a/b/'); the server checked it stays inside the root.
    gamePath: option('path', '').split('/').filter(function (p) { return p && p !== '.' && p !== '..'; })
      .map(encodeURIComponent).map(function (p) { return p + '/'; }).join('')
  };

  // ---- session state
  var devices = [];          // device id -> device_data as the platform knows it (undefined: not connected)
  var frames = {};           // device id -> iframe element
  var profiles = {};         // phone id -> {nickname, uid, premium, language}; kept for reconnects
  var screenProfile = { uid: 'screen-' + Math.random().toString(36).slice(2, 8) };
  var info = {};             // device id -> what its API sent in 'ready' (version, silencePlayers, ...)
  var orientation = {};      // device id -> 'portrait' | 'landscape'
  var nextId = 1;
  var screenReady = false;
  var pendingPhones = [];    // phones added before the screen's API was ready
  var paused = false;
  var ad = null;             // {id, timer} while an ad is running
  var adCount = 0;
  var highscores = [];
  var persistent = JSON.parse(JSON.stringify(config.persistentData));
  var seq = 0;

  var $ = function (id) { return document.getElementById(id); };
  var clone = function (value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); };

  // ---- event recording (UI log + Node side)
  function emit(type, fields) {
    var event = Object.assign({ seq: ++seq, time: Date.now(), type: type }, fields);
    if (typeof window.__acPlaytestEmit === 'function') {
      try { window.__acPlaytestEmit(clone(event)); } catch (e) { /* page closing */ }
    }
    renderLog(event);
    return event;
  }

  // ---- transport
  function send(id, payload) {
    var frame = frames[id];
    if (!frame || !frame.contentWindow) return;
    // JSON round-trip like the real network hop: undefined fields vanish, NaN becomes null, and so on.
    var text = JSON.stringify(payload);
    setTimeout(function () {
      if (frames[id] === frame && frame.contentWindow) frame.contentWindow.postMessage(JSON.parse(text), '*');
    }, config.latency);
  }

  // Devices whose API has received 'ready' (they get updates and messages).
  function readyIds() {
    var ids = [];
    for (var i = 0; i < devices.length; i++) if (devices[i] && info[i]) ids.push(i);
    return ids;
  }

  function sendUpdate(id, flags, exceptId) {
    var data = devices[id] ? Object.assign(clone(devices[id]), flags || {}) : undefined;
    readyIds().forEach(function (other) {
      if (other !== exceptId) send(other, { action: 'update', device_id: id, device_data: data });
    });
  }

  function idOf(source) {
    for (var id in frames) if (frames[id].contentWindow === source) return Number(id);
  }

  window.addEventListener('message', function (event) {
    var id = idOf(event.source);
    var data = event.data;
    if (id === undefined || !data || typeof data !== 'object') return;
    handle(id, data);
  });

  function handle(id, data) {
    switch (data.action) {
      case 'ready': return onApiReady(id, data);
      case 'message': return route(id, data.to, data.data);
      case 'set': return onSet(id, data.key, data.value);
      case 'jserror':
        return emit('jserror', { device: id, message: data.exception && data.exception.message, url: data.url });
      case 'event':
        emit('platformEvent', { device: id, name: data.type });
        // No microphone in the sim: every getUserMedia request is denied.
        if (data.type === 'requestUserMediaPermission') send(id, { action: 'event', type: 'userMediaPermissionDenied' });
        return;
    }
  }

  function onApiReady(id, data) {
    if (info[id] && devices[id]) disconnect(id, true); // the frame reloaded: leave, then join again
    info[id] = {
      version: data.version, silencePlayers: !!data.silencePlayers, translation: !!data.translation,
      synchronize_time: !!data.synchronize_time, device_motion: data.device_motion
    };
    var profile = id === SCREEN ? screenProfile : profiles[id];
    var device = {
      uid: profile.uid, nickname: profile.nickname, location: data.location, custom: undefined,
      language: profile.language || config.language, auth: false, slow_connection: false
    };
    if (id === SCREEN) {
      device.silencePlayers = !!data.silencePlayers;
    } else {
      device.premium = !!profile.premium;
    }
    devices[id] = device;

    var ready = {
      action: 'ready', device_id: id, code: config.code, devices: clone(devices),
      server_time_offset: config.serverTimeOffset
    };
    // Only fields that are configured are sent; the rest stay undefined in the game (never null).
    var dict = config.translations && (config.translations[device.language] || config.translations.en);
    if (data.translation && dict) ready.translations = dict;
    if (id === SCREEN && config.gameSafeArea) ready.gameSafeArea = config.gameSafeArea;
    if (id === SCREEN && config.gameConfiguration) ready.gameConfiguration = config.gameConfiguration;
    send(id, ready);
    sendUpdate(id, null, id);
    emit('ready', { device: id, version: data.version, silencePlayers: !!data.silencePlayers });
    if (id === SCREEN) {
      screenReady = true;
      pendingPhones.splice(0).forEach(createPhoneFrame);
    } else {
      emit('connect', { device: id, nickname: device.nickname, premium: device.premium });
    }
    render();
  }

  function route(from, to, data) {
    var payload = clone(data);
    emit('message', { from: from, to: to === undefined || to === null ? 'all' : to, data: payload });
    var targets = to === undefined || to === null
      ? readyIds().filter(function (id) { return id !== from; })
      : (devices[to] && info[to] ? [to] : []);
    targets.forEach(function (target) {
      send(target, { action: 'message', from: from, to: to, data: payload });
    });
  }

  function onSet(id, key, value) {
    switch (key) {
      case 'custom':
        if (!devices[id]) return;
        devices[id].custom = clone(value);
        sendUpdate(id, { _is_custom_update: true }, id);
        return emit('custom', { device: id, value: clone(value) });
      case 'players':
        if (id !== SCREEN) return;
        devices[SCREEN].players = clone(value);
        sendUpdate(SCREEN, { _is_players_update: true }, SCREEN);
        emit('players', { value: clone(value) });
        return render();
      case 'ad': return id === SCREEN && requestAd();
      case 'orientation':
        if (value === undefined) return;
        orientation[id] = value;
        emit('orientation', { device: id, value: value });
        return render();
      case 'home': return emit('navigate', { device: id, url: value === true ? 'home' : value });
      case 'vibrate': return emit('vibrate', { device: id, value: clone(value) });
      case 'immersive': return emit('immersive', { device: id, value: clone(value) });
      case 'premium': return makePremium(id);
      case 'highscore': return storeHighScore(id, value);
      case 'highscores': return sendHighScores(id, value);
      case 'persistentstore': {
        persistent[value.uid] = persistent[value.uid] || {};
        persistent[value.uid][value.key] = clone(value.value);
        send(id, { action: 'persistentstore', uid: value.uid });
        return emit('persistentStore', { device: id, uid: value.uid, key: value.key, value: clone(value.value) });
      }
      case 'persistentrequest': {
        var result = {};
        (value.uids || []).forEach(function (uid) { result[uid] = clone(persistent[uid] || {}); });
        send(id, { action: 'persistentrequest', data: result });
        return emit('persistentRequest', { device: id, uids: value.uids });
      }
      case 'ga': case 'download_progress': return; // analytics pings from the official library
      default: return emit('set', { device: id, key: key, value: clone(value) });
    }
  }

  // ---- ads: onAdShow on every device, onAdComplete(true) after adDuration; without fill only onAdComplete(false)
  function requestAd() {
    var id = ++adCount;
    emit('ad', { id: id, phase: 'request' });
    if (ad) return emit('ad', { id: id, phase: 'ignored', reason: 'an ad is already running' });
    var all = readyIds();
    if (!config.adFill) {
      all.forEach(function (d) { send(d, { action: 'ad', complete: false }); });
      return emit('ad', { id: id, phase: 'complete', shown: false });
    }
    all.forEach(function (d) { send(d, { action: 'ad' }); });
    emit('ad', { id: id, phase: 'show' });
    ad = { id: id, timer: setTimeout(function () {
      ad = null;
      readyIds().forEach(function (d) { send(d, { action: 'ad', complete: true }); });
      emit('ad', { id: id, phase: 'complete', shown: true });
      render();
    }, config.adDuration) };
    render();
  }

  function makePremium(id) {
    if (!devices[id] || id === SCREEN) return;
    devices[id].premium = true;
    profiles[id].premium = true;
    readyIds().forEach(function (d) { send(d, { action: 'premium', device_id: id }); });
    emit('premium', { device: id });
    render();
  }

  // ---- high scores (in memory, simplified ranking: one global list per level name + version)
  function storeHighScore(id, value) {
    var uids = String(value.uid);
    var best = highscores.filter(function (h) {
      return h.uids === uids && h.level_name === value.level_name && h.level_version === value.level_version;
    })[0];
    var stored = null;
    if (!best || value.score >= best.score) {
      if (best) highscores.splice(highscores.indexOf(best), 1);
      stored = {
        level_name: value.level_name, level_version: value.level_version, score: value.score,
        score_string: value.score_string || (Math.floor(value.score) + ' points'), data: clone(value.data),
        uids: uids, nicknames: nicknamesOf(uids), timestamp: Date.now(), relationship: 'requested'
      };
      highscores.push(stored);
      stored = Object.assign({}, stored, { ranks: { world: rankOf(stored) } });
    }
    send(id, { action: 'highscore', highscore: stored });
    emit('highScoreStored', { device: id, highscore: clone(stored) });
  }

  function levelScores(name, version) {
    return highscores.filter(function (h) { return h.level_name === name && h.level_version === version; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  function rankOf(entry) { return levelScores(entry.level_name, entry.level_version).indexOf(entry) + 1; }

  function sendHighScores(id, request) {
    var list = levelScores(request.level_name, request.level_version);
    var wanted = (request.uids || []).map(String);
    var picked = list.slice(0, request.top);
    list.forEach(function (h) {
      var requested = h.uids.split('|').some(function (u) { return wanted.indexOf(u) >= 0; });
      if (requested && picked.indexOf(h) < 0) picked.push(h);
    });
    var result = picked.slice(0, request.total).map(function (h) {
      var requested = h.uids.split('|').some(function (u) { return wanted.indexOf(u) >= 0; });
      return Object.assign({}, h, { ranks: { world: rankOf(h) }, relationship: requested ? 'requested' : 'other' });
    });
    send(id, { action: 'highscores', highscores: result });
    emit('highScores', { device: id, level_name: request.level_name, count: result.length });
  }

  function nicknamesOf(uids) {
    return uids.split('|').map(function (uid) {
      for (var id in profiles) if (profiles[id].uid === uid) return profiles[id].nickname;
      return uid;
    }).join('|');
  }

  // ---- phones
  function addPhone(profile) {
    profile = profile || {};
    var id = nextId++;
    profiles[id] = {
      nickname: profile.nickname || ('Guest ' + id),
      uid: profile.uid || ('uid-' + id + '-' + Math.random().toString(36).slice(2, 8)),
      premium: !!profile.premium,
      language: profile.language || config.language
    };
    if (screenReady) createPhoneFrame(id);
    else pendingPhones.push(id);
    render();
    return id;
  }

  function createPhoneFrame(id) {
    var frame = document.createElement('iframe');
    frame.id = 'ac-phone-' + id;
    frame.className = 'ac-device-frame';
    frame.setAttribute('allow', FRAME_POLICY);
    frame.src = '/' + config.gamePath + 'controller.html';
    frames[id] = frame;
    emit('join', { device: id, nickname: profiles[id].nickname });
    render();
    phoneTile(id).querySelector('.ac-frame-box').appendChild(frame);
  }

  // A device leaves: its frame goes away and every other device gets an update without device data.
  function disconnect(id, keepFrame) {
    if (!keepFrame && frames[id]) {
      frames[id].remove();
      delete frames[id];
    }
    var wasConnected = !!devices[id];
    devices[id] = undefined;
    delete info[id];
    if (wasConnected) {
      sendUpdate(id, null, id);
      emit('disconnect', { device: id });
    }
    render();
  }

  // Returns 'disconnected' (it was connected), 'removed' (it was still loading) or false (no such phone).
  function dropPhone(id) {
    var pending = pendingPhones.indexOf(id);
    if (pending >= 0) {
      pendingPhones.splice(pending, 1);
      render();
      return 'removed';
    }
    if (id === SCREEN || !frames[id]) return false;
    var wasConnected = !!devices[id];
    disconnect(id, false);
    return wasConnected ? 'disconnected' : 'removed';
  }

  // Device ids stay reserved: a reconnecting phone gets its old id (and nickname / uid) back.
  function reconnect(id) {
    if (!profiles[id] || frames[id] || pendingPhones.indexOf(id) >= 0) return false;
    if (screenReady) createPhoneFrame(id);
    else pendingPhones.push(id);
    return true;
  }

  function setPremium(id) { makePremium(id); return !!(devices[id] && devices[id].premium); }

  function setNickname(id, nickname) {
    if (!devices[id]) return false;
    profiles[id].nickname = nickname;
    devices[id].nickname = nickname;
    sendUpdate(id, { _is_profile_update: true }, id);
    send(id, { action: 'profile', nickname: nickname, auth: devices[id].auth, picture: devices[id].picture });
    emit('profile', { device: id, nickname: nickname });
    render();
    return true;
  }

  function pause() {
    paused = true;
    send(SCREEN, { action: 'pause' });
    emit('pause', {});
    render();
  }

  function resume() {
    paused = false;
    send(SCREEN, { action: 'resume' });
    emit('resume', {});
    render();
  }

  function masterId() {
    var ids = readyIds().filter(function (id) { return id !== SCREEN; });
    var premium = ids.filter(function (id) { return devices[id].premium; });
    return premium.length ? premium[0] : ids[0];
  }

  function isSilenced(id) {
    var screen = devices[SCREEN];
    return !!screen && screen.silencePlayers && !!screen.players && screen.players.length > 0 &&
      screen.players.indexOf(id) < 0;
  }

  // ---- UI
  function phoneTile(id) {
    var tile = $('ac-tile-' + id);
    if (tile) return tile;
    tile = document.createElement('div');
    tile.id = 'ac-tile-' + id;
    tile.className = 'ac-tile';
    tile.innerHTML = '<div class="ac-label"><span class="ac-name"></span><span class="ac-badges"></span>' +
      '<button class="ac-drop" title="Disconnect this phone">drop</button>' +
      '<button class="ac-reconnect" title="Reconnect with the same device id">reconnect</button></div>' +
      '<div class="ac-frame-wrap"><div class="ac-frame-box"></div><div class="ac-overlay ac-silenced">' +
      'Silenced: waiting for the round to end</div><div class="ac-overlay ac-gone">disconnected</div></div>';
    tile.querySelector('.ac-drop').onclick = function () { dropPhone(id); };
    tile.querySelector('.ac-reconnect').onclick = function () { reconnect(id); };
    $('ac-phones').appendChild(tile);
    return tile;
  }

  function sizeFrame(wrap, box, frame, w, h) {
    wrap.style.width = Math.round(w * config.scale) + 'px';
    wrap.style.height = Math.round(h * config.scale) + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.style.transform = 'scale(' + config.scale + ')';
    if (frame) { frame.style.width = w + 'px'; frame.style.height = h + 'px'; }
  }

  function render() {
    var s = config.screenSize;
    sizeFrame($('ac-screen-wrap'), $('ac-screen-box'), frames[SCREEN], s.width, s.height);
    $('ac-screen-wrap').classList.toggle('ac-paused', paused);
    $('ac-screen-wrap').classList.toggle('ac-ad', !!ad);
    $('ac-pause').textContent = paused ? 'Resume' : 'Pause';
    $('ac-adfill').checked = config.adFill;
    var master = masterId();
    Object.keys(profiles).forEach(function (key) {
      var id = Number(key);
      var tile = phoneTile(id);
      var p = profiles[id];
      var portrait = (orientation[id] || 'portrait') === 'portrait';
      var base = config.phoneSize;
      var w = portrait ? Math.min(base.width, base.height) : Math.max(base.width, base.height);
      var h = portrait ? Math.max(base.width, base.height) : Math.min(base.width, base.height);
      sizeFrame(tile.querySelector('.ac-frame-wrap'), tile.querySelector('.ac-frame-box'), frames[id], w, h);
      tile.querySelector('.ac-name').textContent = '#' + id + ' ' + p.nickname;
      var badges = [];
      if (id === master) badges.push('master');
      if (devices[id] && devices[id].premium) badges.push('premium');
      tile.querySelector('.ac-badges').textContent = badges.join(' · ');
      tile.classList.toggle('ac-is-gone', !frames[id]);
      tile.classList.toggle('ac-is-silenced', !!frames[id] && isSilenced(id));
    });
    var phones = readyIds().filter(function (id) { return id !== SCREEN; }).length;
    $('ac-status').textContent = 'code ' + config.code + ' · ' + phones + ' phone(s) · ads ' + adCount +
      (paused ? ' · paused' : '');
  }

  function renderLog(event) {
    var list = $('ac-log-list');
    if (!list) return;
    var line = document.createElement('div');
    var detail = Object.assign({}, event);
    delete detail.seq; delete detail.time; delete detail.type;
    line.textContent = new Date(event.time).toISOString().slice(11, 23) + '  ' + event.type + '  ' +
      JSON.stringify(detail).slice(0, 300);
    list.prepend(line);
    while (list.childNodes.length > 200) list.lastChild.remove();
  }

  function boot() {
    $('ac-add').onclick = function () { addPhone(); };
    $('ac-add-premium').onclick = function () { addPhone({ premium: true }); };
    $('ac-pause').onclick = function () { (paused ? resume : pause)(); };
    $('ac-adfill').onchange = function (e) { config.adFill = e.target.checked; };
    var screen = document.createElement('iframe');
    screen.id = 'ac-screen';
    screen.className = 'ac-device-frame';
    screen.setAttribute('allow', FRAME_POLICY);
    screen.src = '/' + config.gamePath + 'screen.html';
    frames[SCREEN] = screen;
    $('ac-screen-box').appendChild(screen);
    render();
    for (var i = 0; i < config.phones; i++) addPhone();
  }

  window.__acPlatform = {
    addPhone: addPhone,
    dropPhone: dropPhone,
    reconnect: reconnect,
    pause: pause,
    resume: resume,
    setPremium: setPremium,
    setNickname: setNickname,
    setAdFill: function (fill) { config.adFill = !!fill; render(); },
    // Sends a message as if device `from` had called airconsole.message(to, data).
    inject: function (from, to, data) { route(from, to, data); },
    deviceMotion: function (id, data) { send(id, { action: 'device_motion', data: data }); },
    setSafeArea: function (area) {
      config.gameSafeArea = area;
      send(SCREEN, { action: 'setGameSafeArea', gameSafeArea: area });
    },
    state: function () {
      return clone({
        devices: devices, paused: paused, adRunning: !!ad, ads: adCount, master: masterId(),
        players: devices[SCREEN] && devices[SCREEN].players, profiles: profiles, orientation: orientation,
        highscores: highscores, persistentData: persistent
      });
    }
  };

  boot();
})();
