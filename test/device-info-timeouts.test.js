'use strict';
/* eslint-disable node/no-missing-require, node/no-unsupported-features */

const assert = require('assert');
const test = require('node:test');

const DeviceInfo = require('../lib/device_info');

const TOKEN = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function deferred() {
	let reject;
	let resolve;
	const promise = new Promise((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});

	return { promise, reject, resolve };
}

function createDevice() {
	const device = new DeviceInfo({ socket: {} }, 1, '192.0.2.1', 54321);
	device.packet.token = TOKEN;
	device.handshake = async function() {
		return this.token;
	};
	return device;
}

function requestId(device) {
	return JSON.parse(device.packet.data.toString('utf8')).id;
}

function reply(device, id, result) {
	const listener = device.promises.get(id);
	if(listener) listener.resolve(result);
}

function installManualDeadlines(device) {
	const deadlines = [];

	device._createDeadline = function() {
		let rejectTimeout;
		let expired = false;
		const timeoutPromise = new Promise((resolve, reject) => {
			rejectTimeout = reject;
		});
		const deadline = {
			cleared: false,
			clear: function() {
				this.cleared = true;
			},
			expire: function() {
				if(expired) return;
				expired = true;
				const error = new Error('Could not connect to device, handshake timeout');
				error.code = 'timeout';
				rejectTimeout(error);
			},
			race: function(promise) {
				return Promise.race([ promise, timeoutPromise ]);
			}
		};

		deadlines.push(deadline);
		return deadline;
	};

	return deadlines;
}

async function waitFor(predicate, message) {
	for(let i=0; i<20; i++) {
		if(predicate()) return;
		await new Promise(resolve => setImmediate(resolve));
	}

	assert.fail(message);
}

test('cleans response listeners after all dropped attempts time out', async () => {
	const device = createDevice();
	const deadlines = installManualDeadlines(device);
	const sentIds = [];

	device._sendPacket = async function() {
		sentIds.push(requestId(device));
	};

	const call = device.call('test.method', [], { retries: 2 });
	await waitFor(() => deadlines.length === 1 && sentIds.length === 1, 'first attempt did not start');
	deadlines[0].expire();
	await waitFor(() => deadlines.length === 2 && sentIds.length === 2, 'retry did not start');
	deadlines[1].expire();

	await assert.rejects(call, error => error.code === 'timeout' && error.message === 'Call to device timed out');
	assert.deepStrictEqual(sentIds, [ 1, 101 ]);
	assert.strictEqual(device.promises.size, 0);
	assert.ok(deadlines.every(deadline => deadline.cleared));
});

test('zero retries starts no attempt', async () => {
	const device = createDevice();
	const deadlines = installManualDeadlines(device);
	let sends = 0;

	device._sendPacket = async function() {
		sends++;
	};

	await assert.rejects(
		device.call('test.method', [], { retries: 0 }),
		error => error.code === 'timeout' && error.message === 'Call to device timed out'
	);
	assert.strictEqual(sends, 0);
	assert.strictEqual(deadlines.length, 0);
	assert.strictEqual(device.promises.size, 0);
});

test('clears the two-second deadline after a successful call', async () => {
	const originalSetTimeout = global.setTimeout;
	const originalClearTimeout = global.clearTimeout;
	const timers = [];

	global.setTimeout = function(handler, delay) {
		const timer = { cleared: false, delay, handler };
		timers.push(timer);
		return timer;
	};
	global.clearTimeout = function(timer) {
		timer.cleared = true;
	};

	try {
		const device = createDevice();
		device._sendPacket = async function() {
			reply(device, requestId(device), 'ok');
		};

		assert.strictEqual(await device.call('test.method', [], { retries: 1 }), 'ok');
		assert.strictEqual(device.promises.size, 0);
		assert.strictEqual(timers.length, 1);
		assert.strictEqual(timers[0].delay, 2000);
		assert.strictEqual(timers[0].cleared, true);
	} finally {
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	}
});

test('retries once after a dropped response and uses the retry request id', async () => {
	const device = createDevice();
	const deadlines = installManualDeadlines(device);
	const sentIds = [];

	device._sendPacket = async function() {
		const id = requestId(device);
		sentIds.push(id);
		if(sentIds.length === 2) reply(device, id, 'retry response');
	};

	const call = device.call('test.method', [], { retries: 2 });
	await waitFor(() => sentIds.length === 1, 'first attempt did not send');
	deadlines[0].expire();

	assert.strictEqual(await call, 'retry response');
	assert.deepStrictEqual(sentIds, [ 1, 101 ]);
	assert.strictEqual(device.promises.size, 0);
	assert.ok(deadlines.every(deadline => deadline.cleared));
});

test('late send completion and reply cannot settle a subsequent call', async () => {
	const device = createDevice();
	const deadlines = installManualDeadlines(device);
	const delayedSend = deferred();
	const sentIds = [];

	device._sendPacket = function() {
		const id = requestId(device);
		sentIds.push(id);
		return sentIds.length === 1 ? delayedSend.promise : Promise.resolve();
	};

	const firstCall = device.call('test.method', [], { retries: 1 });
	await waitFor(() => sentIds.length === 1, 'first call did not send');
	const expiredId = sentIds[0];
	deadlines[0].expire();
	await assert.rejects(firstCall, error => error.code === 'timeout');
	assert.strictEqual(device.promises.size, 0);

	let secondSettled = false;
	const secondCall = device.call('test.method', [], { retries: 1 });
	secondCall.then(() => {
		secondSettled = true;
	}, () => {
		secondSettled = true;
	});
	await waitFor(() => sentIds.length === 2, 'second call did not send');
	const activeId = sentIds[1];

	delayedSend.resolve();
	reply(device, expiredId, 'late response');
	await new Promise(resolve => setImmediate(resolve));
	assert.strictEqual(secondSettled, false);
	assert.strictEqual(device.promises.has(activeId), true);
	assert.strictEqual(sentIds.length, 2);

	reply(device, activeId, 'current response');
	assert.strictEqual(await secondCall, 'current response');
	assert.strictEqual(device.promises.size, 0);
});

test('cleans the response listener and deadline after a send error', async () => {
	const device = createDevice();
	const deadlines = installManualDeadlines(device);
	const sendError = new Error('send failed');

	device._sendPacket = async function() {
		throw sendError;
	};

	await assert.rejects(device.call('test.method', [], { retries: 2 }), sendError);
	assert.strictEqual(deadlines.length, 1);
	assert.strictEqual(deadlines[0].cleared, true);
	assert.strictEqual(device.promises.size, 0);
});

test('concurrent handshakes share work and a failure is cleared for retry', async () => {
	const device = new DeviceInfo({ socket: {} }, 1, '192.0.2.1', 54321);
	const deadlines = installManualDeadlines(device);
	const operations = [ deferred(), deferred() ];
	let operationIndex = 0;

	device._sendHandshakePackage = function(deadline) {
		const operation = operations[operationIndex++];
		return deadline.race(operation.promise);
	};

	const first = device.handshake();
	const concurrent = device.handshake();
	const firstResults = Promise.allSettled([ first, concurrent ]);
	const handshakeError = new Error('handshake send failed');
	operations[0].reject(handshakeError);

	const results = await firstResults;
	assert.strictEqual(operationIndex, 1);
	assert.strictEqual(results[0].status, 'rejected');
	assert.strictEqual(results[0].reason, handshakeError);
	assert.strictEqual(results[1].status, 'rejected');
	assert.strictEqual(results[1].reason, handshakeError);
	assert.strictEqual(device.handshakePromise, null);
	assert.strictEqual(device.handshakeState, null);
	assert.strictEqual(deadlines[0].cleared, true);

	const retry = device.handshake();
	operations[1].resolve(TOKEN);
	assert.strictEqual(await retry, TOKEN);
	assert.strictEqual(operationIndex, 2);
	assert.strictEqual(device.handshakePromise, null);
	assert.strictEqual(device.handshakeState, null);
	assert.strictEqual(deadlines[1].cleared, true);
});

test('accepts a valid handshake reply without waiting for the UDP send callback', async () => {
	const device = new DeviceInfo({ socket: {} }, 1, '192.0.2.1', 54321);
	device.packet.token = TOKEN;
	const deadlines = installManualDeadlines(device);
	const pendingSend = deferred();
	device._sendPacket = function() {
		const packet = Buffer.from(this.packet.raw);
		packet.writeUInt32BE(0, 4);
		packet.writeUInt32BE(1, 8);
		packet.writeUInt32BE(123456, 12);
		setImmediate(() => this.onMessage(packet));
		return pendingSend.promise;
	};

	const outcome = device.handshake().then(
		value => ({ value }),
		error => ({ error })
	);
	await new Promise(resolve => setImmediate(resolve));
	if(!deadlines[0].cleared) deadlines[0].expire();
	const result = await outcome;
	assert.strictEqual(result.error, undefined);
	assert.deepStrictEqual(result.value, TOKEN);
	assert.strictEqual(deadlines[0].cleared, true);
	assert.strictEqual(device.handshakePromise, null);
	assert.strictEqual(device.handshakeState, null);
	assert.strictEqual(device.handshakeResolve, null);
	pendingSend.resolve();
});

test('accepts a valid command reply without waiting for the UDP send callback', async () => {
	const device = createDevice();
	const deadlines = installManualDeadlines(device);
	const pendingSend = deferred();
	device._sendPacket = function() {
		const id = requestId(device);
		setImmediate(() => reply(device, id, [ { did: 'power', code: 0, value: false } ]));
		return pendingSend.promise;
	};

	const outcome = device.call('get_properties', [ { did: 'power', siid: 2, piid: 2 } ], { retries: 1 }).then(
		value => ({ value }),
		error => ({ error })
	);
	await waitFor(() => device.promises.size === 1, 'request did not start');
	await new Promise(resolve => setImmediate(resolve));
	if(!deadlines[0].cleared) deadlines[0].expire();
	const result = await outcome;
	assert.strictEqual(result.error, undefined);
	assert.deepStrictEqual(result.value, [ { did: 'power', code: 0, value: false } ]);
	assert.strictEqual(deadlines[0].cleared, true);
	assert.strictEqual(device.promises.size, 0);
	// A delayed send error must be handled even after the response completed the call.
	pendingSend.reject(new Error('late send callback error'));
	await new Promise(resolve => setImmediate(resolve));
});

test('preserves legacy property, vacuum status and write acknowledgements', async () => {
	for(const scenario of [
		{ method: 'get_prop', params: [ 'power', 'speed' ], result: [ 'off', 0 ] },
		{ method: 'get_status', params: [], result: [ { state: 8, battery: 63 } ] },
		{ method: 'set_power', params: [ 'on' ], result: [ 'ok' ] }
	]) {
		const device = createDevice();
		const deadlines = installManualDeadlines(device);
		device._sendPacket = async function() {
			const request = JSON.parse(this.packet.data.toString('utf8'));
			assert.strictEqual(request.method, scenario.method);
			assert.deepStrictEqual(request.params, scenario.params);
			reply(this, request.id, scenario.result);
		};

		assert.deepStrictEqual(await device.call(scenario.method, scenario.params, { retries: 1 }), scenario.result);
		assert.strictEqual(device.promises.size, 0);
		assert.ok(deadlines.every(deadline => deadline.cleared));
	}
});
