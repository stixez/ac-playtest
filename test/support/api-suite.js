// AirConsole API behaviour, checked through the dummy game. Runs against the built-in stand-in (api.test.js) and,
// opt-in, against the official library from airconsole.com (official-api.test.js), which checks that the
// simulated platform speaks the same protocol as the real client expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useBrowser, callbacks, expectCallbacks, until } from './helpers.js';

export function apiSuite(api) {
  const newSim = useBrowser();
  const start = (t, options) => newSim(t, { api, ...options });
  const screenOnly = { only: ['onReady', 'onConnect', 'onDisconnect', 'onDeviceStateChange'] };

  test('screen: onReady(code) first; a phone joining gives onDeviceStateChange, then onConnect', async (t) => {
    const sim = await start(t);
    await expectCallbacks(sim.screen, ['onReady 1234 5678']);
    const phone = await sim.addPhone({ nickname: 'Mia' });
    assert.equal(phone.id, 1);
    await expectCallbacks(sim.screen, ['onReady 1234 5678', 'onDeviceStateChange 1 {...}', 'onConnect 1']);
    // The phone: onReady, then onConnect for every device already running the game (here: the screen).
    await expectCallbacks(phone, ['onReady 1234 5678', 'onConnect 0']);
    assert.equal(await sim.screen.evaluate(() => airconsole.getNickname(1)), 'Mia');
    assert.equal(await phone.evaluate(() => airconsole.getDeviceId()), 1);
  });

  test('a later phone hears about earlier phones; earlier phones hear about it', async (t) => {
    const sim = await start(t, { phones: 2 });
    const [p1, p2] = sim.phones();
    await expectCallbacks(p2, ['onReady 1234 5678', 'onConnect 0', 'onConnect 1'], screenOnly);
    await expectCallbacks(p1, ['onReady 1234 5678', 'onConnect 0', 'onDeviceStateChange 2 {...}', 'onConnect 2'],
      screenOnly);
    assert.deepEqual(await p2.evaluate(() => airconsole.getControllerDeviceIds()), [1, 2]);
  });

  test('disconnect: onDeviceStateChange(id, undefined), then onDisconnect; reconnect keeps the id', async (t) => {
    const sim = await start(t, { phones: 2 });
    await sim.dropPhone(1);
    await expectCallbacks(sim.screen, [
      'onReady 1234 5678', 'onDeviceStateChange 1 {...}', 'onConnect 1', 'onDeviceStateChange 2 {...}', 'onConnect 2',
      'onDeviceStateChange 1 undefined', 'onDisconnect 1',
    ], screenOnly);
    assert.deepEqual(await sim.screen.evaluate(() => airconsole.getControllerDeviceIds()), [2]);
    assert.deepEqual(sim.phones().map((p) => p.id), [2]);

    const back = await sim.reconnect(1);
    assert.equal(back.id, 1);
    await until(async () => (await callbacks(sim.screen)).at(-1) === 'onConnect 1');
    assert.equal(await back.evaluate(() => airconsole.getNickname()), 'Guest 1');
    // A new phone never reuses an id.
    assert.equal((await sim.addPhone()).id, 3);
  });

  test('master controller: lowest connected id, premium devices first', async (t) => {
    const sim = await start(t, { phones: 2 });
    const master = () => sim.screen.evaluate(() => airconsole.getMasterControllerDeviceId());
    assert.equal(await master(), 1);
    const vip = await sim.addPhone({ premium: true });
    await until(master, { expected: 3 });
    assert.equal(await sim.screen.evaluate((id) => airconsole.isPremium(id), vip.id), true);
    assert.deepEqual(await callbacks(sim.screen, { only: ['onPremium'] }), ['onPremium 3']);
    await sim.dropPhone(vip);
    await until(master, { expected: 1 });
    await sim.dropPhone(1);
    await until(master, { expected: 2 });
    await sim.dropPhone(2);
    await until(async () => (await sim.screen.evaluate(() => airconsole.getControllerDeviceIds())).length === 0);
    assert.equal(await master(), undefined);
  });

  test('messages: controller -> screen, screen -> one controller, broadcast; all JSON round-tripped', async (t) => {
    const sim = await start(t, { phones: 2 });
    const [p1, p2] = sim.phones();
    await p1.evaluate(() => airconsole.message(AirConsole.SCREEN, { type: 'hello', when: new Date(0), skip: undefined, n: NaN }));
    const got = await sim.waitForMessage({ from: 1, type: 'hello' });
    assert.deepEqual(got.data, { type: 'hello', when: '1970-01-01T00:00:00.000Z', n: null });
    await until(async () => (await callbacks(sim.screen, { json: true, only: ['onMessage'] }))
      .includes('onMessage 1 {"type":"hello","when":"1970-01-01T00:00:00.000Z","n":null}'));

    await sim.screen.evaluate(() => airconsole.message(2, { type: 'private', list: [1, undefined, 3] }));
    await until(async () => (await callbacks(p2, { json: true, only: ['onMessage'] }))
      .includes('onMessage 0 {"type":"private","list":[1,null,3]}'));

    await sim.screen.evaluate(() => airconsole.broadcast({ type: 'all' }));
    await until(async () => (await callbacks(p1, { json: true, only: ['onMessage'] })).includes('onMessage 0 {"type":"all"}'));
    await until(async () => (await callbacks(p2, { json: true, only: ['onMessage'] })).includes('onMessage 0 {"type":"all"}'));
    // The sender of a broadcast does not receive it; p1 never got p2's private message.
    assert.ok(!(await callbacks(sim.screen, { json: true })).some((c) => c.includes('"type":"all"')));
    assert.ok(!(await callbacks(p1, { json: true })).some((c) => c.includes('private')));

    // Controller to controller.
    await p1.evaluate(() => airconsole.message(2, { type: 'psst' }));
    await until(async () => (await callbacks(p2, { json: true, only: ['onMessage'] })).includes('onMessage 1 {"type":"psst"}'));
    assert.deepEqual(sim.messages({ to: 2 }).map((m) => m.data.type), ['private', 'all', 'psst']);
  });

  test('setActivePlayers: player numbers on every device, onActivePlayersChange on controllers', async (t) => {
    const sim = await start(t, { phones: 3 });
    const [, p2, p3] = sim.phones();
    await sim.screen.evaluate(() => airconsole.setActivePlayers(2));
    assert.deepEqual(await sim.screen.evaluate(() => airconsole.getActivePlayerDeviceIds()), [1, 2]);
    assert.equal(await sim.screen.evaluate(() => airconsole.convertPlayerNumberToDeviceId(1)), 2);
    assert.equal(await sim.screen.evaluate(() => airconsole.convertDeviceIdToPlayerNumber(3)), undefined);
    await until(async () => (await callbacks(p2, { only: ['onActivePlayersChange'] })).includes('onActivePlayersChange 1'));
    await until(async () => (await callbacks(p3, { only: ['onActivePlayersChange'] })).includes('onActivePlayersChange undefined'));
    assert.deepEqual(await p3.evaluate(() => airconsole.getActivePlayerDeviceIds()), [1, 2]);
    await assert.rejects(p2.evaluate(() => airconsole.setActivePlayers(1)), /Only the AirConsole.SCREEN/);
  });

  test('player silencing (default for versioned API URLs): late joiners wait until setActivePlayers(0)', async (t) => {
    const sim = await start(t, { phones: 1 });
    assert.equal(await sim.screen.evaluate(() => airconsole.arePlayersSilenced()), false);
    await sim.screen.evaluate(() => airconsole.setActivePlayers(1));
    assert.equal(await sim.screen.evaluate(() => airconsole.arePlayersSilenced()), true);
    const late = await sim.addPhone({ nickname: 'Late' });
    await late.evaluate(() => airconsole.message(AirConsole.SCREEN, { type: 'let me in' }));
    await sim.waitForMessage({ from: late.id, type: 'let me in' }); // it left the phone...
    await new Promise((r) => setTimeout(r, 200));
    const before = await callbacks(sim.screen);
    assert.ok(!before.includes('onConnect 2'), 'silenced phone must not connect yet');
    assert.ok(!before.some((c) => c.startsWith('onMessage 2')), '...but the screen drops it');
    assert.deepEqual(await sim.screen.evaluate(() => airconsole.getControllerDeviceIds()), [1]);

    await sim.screen.evaluate(() => airconsole.setActivePlayers(0));
    await until(async () => (await callbacks(sim.screen)).includes('onConnect 2'));
    assert.deepEqual(await sim.screen.evaluate(() => airconsole.getControllerDeviceIds()), [1, 2]);
  });

  test('ads: onAdShow then onAdComplete(true) on every device; without fill only onAdComplete(false)', async (t) => {
    const sim = await start(t, { phones: 1 });
    const [phone] = sim.phones();
    await sim.screen.evaluate(() => airconsole.showAd());
    const adEvents = { only: ['onAdShow', 'onAdComplete'] };
    await expectCallbacks(sim.screen, ['onAdShow', 'onAdComplete true'], adEvents);
    await expectCallbacks(phone, ['onAdShow', 'onAdComplete true'], adEvents);
    assert.equal(sim.ads().length, 1);
    assert.equal(sim.ads()[0].shown, true);

    await sim.setAdFill(false);
    await sim.screen.evaluate(() => airconsole.showAd());
    await expectCallbacks(sim.screen, ['onAdShow', 'onAdComplete true', 'onAdComplete false'], adEvents);
    assert.deepEqual(sim.ads().map((a) => a.shown), [true, false]);
    await assert.rejects(phone.evaluate(() => airconsole.showAd()), /Only the AirConsole.SCREEN/);
  });

  test('pause / resume reach the screen only', async (t) => {
    const sim = await start(t, { phones: 1 });
    await sim.pause();
    await sim.resume();
    await expectCallbacks(sim.screen, ['onPause', 'onResume'], { only: ['onPause', 'onResume'] });
    assert.equal((await sim.state()).paused, false);
    assert.deepEqual(await callbacks(sim.phones()[0], { only: ['onPause', 'onResume'] }), []);
  });

  test('custom device state: set, set property, change events, and replay for late joiners', async (t) => {
    const sim = await start(t, { phones: 1 });
    const [p1] = sim.phones();
    await p1.evaluate(() => airconsole.setCustomDeviceState({ team: 'red' }));
    await p1.evaluate(() => airconsole.setCustomDeviceStateProperty('ready', true));
    const custom = { only: ['onCustomDeviceStateChange'], json: true };
    await expectCallbacks(sim.screen, [
      'onCustomDeviceStateChange 1 {"team":"red"}', 'onCustomDeviceStateChange 1 {"team":"red","ready":true}',
    ], custom);
    assert.deepEqual(await sim.screen.evaluate(() => airconsole.getCustomDeviceState(1)), { team: 'red', ready: true });

    await sim.screen.evaluate(() => airconsole.setCustomDeviceState({ phase: 'lobby' }));
    await until(async () => (await p1.evaluate(() => airconsole.getCustomDeviceState(0))) !== undefined);
    // A phone that joins later learns existing states right after onReady.
    const p2 = await sim.addPhone();
    await until(async () => (await callbacks(p2, custom)).length === 2);
    assert.deepEqual(await callbacks(p2, custom),
      ['onCustomDeviceStateChange 0 {"phase":"lobby"}', 'onCustomDeviceStateChange 1 {"team":"red","ready":true}']);
  });

  test('ready payload is engine-safe: unset translations / safe area / configuration stay undefined', async (t) => {
    const sim = await start(t, { phones: 1 });
    // What the Unity plugin forwards from onReady; a null in any of these crashed its C# side.
    const payload = await sim.screen.evaluate(() => JSON.stringify({
      translations: airconsole.translations, gameSafeArea: airconsole.gameSafeArea,
      gameConfiguration: airconsole.gameConfiguration,
    }));
    assert.equal(payload, '{}');
    assert.deepEqual(await sim.screen.evaluate(() => airconsole.getGameConfiguration()), {});
    assert.equal(typeof await sim.screen.evaluate(() => airconsole.getServerTime()), 'number');
    await assert.rejects(sim.phones()[0].evaluate(() => airconsole.getServerTime()), /synchronize_time/);
    assert.equal(await sim.screen.evaluate(() => airconsole.getLanguage(1)), 'en');
  });

  test('configured translations, game configuration and safe area reach the screen', async (t) => {
    const sim = await start(t, {
      translations: { en: { hello: 'Hi %name%!' } },
      gameConfiguration: { unityVideoSupport: true },
      gameSafeArea: { top: 0.1, left: 0, bottom: 1, right: 1 },
    });
    assert.equal(await sim.screen.evaluate(() => airconsole.getTranslation('hello', { name: 'Tom' })), 'Hi Tom!');
    assert.deepEqual(await sim.screen.evaluate(() => airconsole.getGameConfiguration()), { unityVideoSupport: true });
    await expectCallbacks(sim.screen, ['onSetSafeArea {"top":0.1,"left":0,"bottom":1,"right":1}'],
      { only: ['onSetSafeArea'], json: true });
  });

  test('high scores and persistent data (in memory) answer through their callbacks', async (t) => {
    const sim = await start(t, { phones: 1, persistentData: { 'uid-x': { coins: 5 } } });
    const [phone] = sim.phones();
    const uid = await phone.evaluate(() => airconsole.getUID());
    await sim.screen.evaluate((u) => airconsole.storeHighScore('Level 1', 'v1', 120, u), uid);
    await until(async () => (await callbacks(sim.screen, { only: ['onHighScoreStored'] })).length === 1);
    const stored = await sim.screen.evaluate(() => events.find((e) => e[0] === 'onHighScoreStored')[1]);
    assert.equal(stored.score, 120);
    assert.equal(stored.ranks.world, 1);
    await sim.screen.evaluate((u) => airconsole.storeHighScore('Level 1', 'v1', 80, u), uid);
    await until(async () => (await callbacks(sim.screen, { only: ['onHighScoreStored'] })).length === 2);
    assert.equal(await sim.screen.evaluate(() => events.filter((e) => e[0] === 'onHighScoreStored')[1][1]), null,
      'a lower score is not a new best');
    await sim.screen.evaluate(() => airconsole.requestHighScores('Level 1', 'v1'));
    await until(async () => (await callbacks(sim.screen, { only: ['onHighScores'] })).length === 1);
    const scores = await sim.screen.evaluate(() => events.find((e) => e[0] === 'onHighScores')[1]);
    assert.deepEqual(scores.map((s) => [s.score, s.uids, s.relationship]), [[120, uid, 'requested']]);

    await sim.screen.evaluate((u) => airconsole.storePersistentData('level', 3, u), uid);
    await until(async () => (await callbacks(sim.screen, { only: ['onPersistentDataStored'] })).length === 1);
    await sim.screen.evaluate((u) => airconsole.requestPersistentData([u, 'uid-x']), uid);
    await until(async () => (await callbacks(sim.screen, { only: ['onPersistentDataLoaded'] })).length === 1);
    assert.deepEqual(await sim.screen.evaluate(() => events.find((e) => e[0] === 'onPersistentDataLoaded')[1]),
      { [uid]: { level: 3 }, 'uid-x': { coins: 5 } });
  });

  test('navigation, vibration, orientation and immersive state are recorded, not executed', async (t) => {
    const sim = await start(t, { phones: 1 });
    const [phone] = sim.phones();
    await phone.evaluate(() => airconsole.vibrate(120));
    await sim.screen.evaluate(() => airconsole.setImmersiveState({ light: { r: 255, g: 0, b: 0 } }));
    await sim.screen.evaluate(() => airconsole.navigateTo('./level2', { seed: 7 }));
    await sim.screen.evaluate(() => airconsole.navigateHome());
    await sim.waitForEvent({ type: 'navigate', url: 'home' });
    assert.deepEqual(sim.events({ type: 'vibrate' }).map((e) => [e.device, e.value]), [[1, 120]]);
    assert.deepEqual(sim.events({ type: 'immersive' })[0].value, { light: { r: 255, g: 0, b: 0 } });
    assert.match(sim.events({ type: 'navigate' })[0].url, /\/level2\/#%7B%22seed%22%3A7%7D$/);
    assert.deepEqual(sim.events({ type: 'orientation', device: 1 }).map((e) => e.value), ['portrait']);
    assert.ok(sim.page.url().endsWith('/__ac/sim.html'), 'nothing navigated');
  });

  test('premium upgrades and nickname changes notify the other devices', async (t) => {
    const sim = await start(t, { phones: 2 });
    const [p1, p2] = sim.phones();
    await p2.evaluate(() => airconsole.getPremium());
    await until(async () => (await callbacks(sim.screen, { only: ['onPremium'] })).includes('onPremium 2'));
    await until(() => sim.screen.evaluate(() => airconsole.getMasterControllerDeviceId()), { expected: 2 });
    await sim.setNickname(1, 'Zoe');
    await until(async () => (await callbacks(sim.screen, { only: ['onDeviceProfileChange'] })).includes('onDeviceProfileChange 1'));
    assert.equal(await sim.screen.evaluate(() => airconsole.getNickname(1)), 'Zoe');
    await until(() => p1.evaluate(() => airconsole.getNickname()), { expected: 'Zoe' });
  });

  test('device motion data reaches the phone', async (t) => {
    const sim = await start(t, { phones: 1 });
    const [phone] = sim.phones();
    await sim.deviceMotion(phone, { x: 1, y: 2, z: 3 });
    await expectCallbacks(phone, ['onDeviceMotion {"x":1,"y":2,"z":3}'], { only: ['onDeviceMotion'], json: true });
  });
}
