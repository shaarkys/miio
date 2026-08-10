'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEVELOPER_API_PATH = path.join(ROOT, 'lib', 'devices', 'gateway', 'developer-api.js');
const GATEWAY_PATH = path.join(ROOT, 'lib', 'devices', 'gateway.js');

class FakeSocket extends EventEmitter {
	constructor() {
		super();

		this.closeCalls = 0;
		this.closed = false;
		this.memberships = [];
		this.sendCalls = [];
	}

	addMembership(address, interfaceAddress) {
		this.memberships.push([ address, interfaceAddress ]);
	}

	bind(options) {
		this.bindOptions = options;
	}

	close() {
		this.closeCalls++;
		if(this.closeError) throw this.closeError;
		if(this.closed) throw new Error('Socket closed twice');

		this.closed = true;
	}

	send() {
		const args = Array.prototype.slice.call(arguments);
		const callback = args[args.length - 1];
		let error;

		this.sendCalls.push(args);
		if(this.closed) {
			error = new Error('UDP subsystem not running');
			error.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
			throw error;
		}

		if(this.syncSendError) throw this.syncSendError;

		if(this.sendError) {
			if(typeof callback !== 'function') {
				throw new Error('Expected a UDP send callback');
			}

			callback(this.sendError);
		}
	}
}

function createParent(logs) {
	return {
		debug: function() {
			logs.push(Array.prototype.slice.call(arguments));
		}
	};
}

function loadDeveloperApi(socket) {
	const originalLoad = Module._load;
	let DeveloperApi;

	delete require.cache[DEVELOPER_API_PATH];
	Module._load = function(request, parent, isMain) {
		if(parent && parent.filename === DEVELOPER_API_PATH) {
			if(request === 'dgram') {
				return {
					createSocket: function() {
						return socket;
					}
				};
			}

			if(request === 'os') {
				return {
					networkInterfaces: function() {
						return {};
					}
				};
			}
		}

		return originalLoad.apply(this, arguments);
	};

	try {
		DeveloperApi = require(DEVELOPER_API_PATH);
	} finally {
		Module._load = originalLoad;
		delete require.cache[DEVELOPER_API_PATH];
	}

	return DeveloperApi;
}

function withFakeTimeouts(callback) {
	const originalSetTimeout = global.setTimeout;
	const originalClearTimeout = global.clearTimeout;
	const timers = [];

	global.setTimeout = function(handler, delay) {
		const timer = {
			cleared: false,
			delay: delay,
			handler: handler
		};

		timers.push(timer);
		return timer;
	};
	global.clearTimeout = function(timer) {
		timer.cleared = true;
	};

	try {
		return callback(timers);
	} finally {
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	}
}

function testDeveloperApiTeardown() {
	withFakeTimeouts(function(timers) {
		const socket = new FakeSocket();
		const DeveloperApi = loadDeveloperApi(socket);
		const api = new DeveloperApi(createParent([]), '192.0.2.1');
		let ready = 0;

		api.on('ready', function() {
			ready++;
		});

		socket.emit('listening');
		assert.strictEqual(socket.sendCalls.length, 1);
		assert.strictEqual(typeof socket.sendCalls[0][5], 'function');
		assert.strictEqual(timers.length, 1);

		const listeningHandler = socket.listeners('listening')[0];
		const messageHandler = socket.listeners('message')[0];
		const readyTimer = timers[0];

		api.destroy();
		api.destroy();

		assert.strictEqual(socket.closeCalls, 1);
		assert.strictEqual(readyTimer.cleared, true);
		assert.doesNotThrow(function() {
			api.read('subdevice');
		});
		assert.strictEqual(socket.sendCalls.length, 1);

		listeningHandler();
		messageHandler(Buffer.from(JSON.stringify({
			cmd: 'iam',
			ip: '192.0.2.1',
			port: 9898,
			sid: 'gateway'
		})));
		readyTimer.handler();

		assert.strictEqual(socket.sendCalls.length, 1);
		assert.strictEqual(ready, 0);
	});
}

function testDeveloperApiSendErrors() {
	const sendError = new Error('active UDP send failed');
	const logs = [];
	const socket = new FakeSocket();
	const DeveloperApi = loadDeveloperApi(socket);
	const api = new DeveloperApi(createParent(logs), '192.0.2.1');

	socket.sendError = sendError;
	api.send({
		cmd: 'read'
	});

	assert.strictEqual(logs[logs.length - 1][0], 'DEV send failed');
	assert.strictEqual(logs[logs.length - 1][1], sendError);
	api.destroy();

	const syncSendError = new Error('unexpected active UDP socket failure');
	const activeSocket = new FakeSocket();
	const ActiveDeveloperApi = loadDeveloperApi(activeSocket);
	const activeApi = new ActiveDeveloperApi(createParent([]), '192.0.2.1');
	let caught;

	activeSocket.syncSendError = syncSendError;
	try {
		activeApi.send({
			cmd: 'read'
		});
	} catch(error) {
		caught = error;
	}

	assert.strictEqual(caught, syncSendError);
	activeApi.destroy();
}

function testDeveloperApiCloseErrors() {
	const expectedCloseError = new Error('UDP subsystem not running');
	const expectedSocket = new FakeSocket();
	const ExpectedDeveloperApi = loadDeveloperApi(expectedSocket);
	const expectedApi = new ExpectedDeveloperApi(createParent([]), '192.0.2.1');

	expectedCloseError.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
	expectedSocket.closeError = expectedCloseError;
	assert.doesNotThrow(function() {
		expectedApi.destroy();
	});
	assert.doesNotThrow(function() {
		expectedApi.destroy();
	});
	assert.strictEqual(expectedSocket.closeCalls, 1);

	const unexpectedCloseError = new Error('unexpected close failure');
	const unexpectedSocket = new FakeSocket();
	const UnexpectedDeveloperApi = loadDeveloperApi(unexpectedSocket);
	const unexpectedApi = new UnexpectedDeveloperApi(createParent([]), '192.0.2.1');
	let caught;

	unexpectedSocket.closeError = unexpectedCloseError;
	try {
		unexpectedApi.destroy();
	} catch(error) {
		caught = error;
	}

	assert.strictEqual(caught, unexpectedCloseError);
	assert.strictEqual(unexpectedSocket.closeCalls, 1);
}

function testDeveloperApiSocketErrors() {
	const activeSocketError = new Error('active socket failure');
	const postDestroySocketError = new Error('socket closed during teardown');
	const logs = [];
	const socket = new FakeSocket();
	const DeveloperApi = loadDeveloperApi(socket);
	const api = new DeveloperApi(createParent(logs), '192.0.2.1');

	socket.emit('error', activeSocketError);
	assert.strictEqual(logs[logs.length - 1][0], 'DEV socket error');
	assert.strictEqual(logs[logs.length - 1][1], activeSocketError);

	api.destroy();
	const logsBeforePostDestroyError = logs.length;
	assert.doesNotThrow(function() {
		socket.emit('error', postDestroySocketError);
	});
	assert.strictEqual(logs.length, logsBeforePostDestroyError);
}

function loadGateway() {
	class Parent {
		static with() {
			return this;
		}

		defineProperty() {
		}

		destroyCallback() {
			return Promise.resolve();
		}

		initCallback() {
			return Promise.resolve();
		}

		debug() {
		}
	}

	class ChildSyncer {
	}

	class Children {
	}

	function MiioApi() {
	}

	function Illuminance() {
	}

	function LightMixin() {
	}

	function SubDevice() {
	}

	const Thing = {
		type: function(factory) {
			return factory(Parent);
		}
	};
	const types = {};
	const originalLoad = Module._load;
	let Gateway;

	delete require.cache[GATEWAY_PATH];
	Module._load = function(request, parent, isMain) {
		if(parent && parent.filename === GATEWAY_PATH) {
			switch(request) {
				case 'abstract-things':
					return {
						Children: Children,
						Thing: Thing
					};
				case 'abstract-things/children':
					return {
						ChildSyncer: ChildSyncer
					};
				case '../device':
					return MiioApi;
				case './capabilities/sensor':
					return {
						Illuminance: Illuminance
					};
				case './gateway/developer-api':
					return function() {
					};
				case './gateway/light-mixin':
					return LightMixin;
				case './gateway/subdevice':
					return SubDevice;
				case './gateway/subdevices':
					return types;
			}
		}

		return originalLoad.apply(this, arguments);
	};

	try {
		Gateway = require(GATEWAY_PATH);
	} finally {
		Module._load = originalLoad;
		delete require.cache[GATEWAY_PATH];
	}

	return Gateway;
}

function withFakeIntervals(callback) {
	const originalSetInterval = global.setInterval;
	const intervals = [];
	let result;

	global.setInterval = function(handler, delay) {
		const interval = {
			delay: delay,
			handler: handler
		};

		intervals.push(interval);
		return interval;
	};

	try {
		result = callback(intervals);
	} catch(error) {
		global.setInterval = originalSetInterval;
		throw error;
	}

	return Promise.resolve(result)
		.then(value => {
			global.setInterval = originalSetInterval;
			return value;
		}, error => {
			global.setInterval = originalSetInterval;
			throw error;
		});
}

function nextTurn() {
	return new Promise(resolve => setImmediate(resolve));
}

function testGatewayDeviceListRefresh() {
	const Gateway = loadGateway().Basic;
	const unhandled = [];
	const onUnhandledRejection = function(error) {
		unhandled.push(error);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	return withFakeIntervals(function(intervals) {
		const gateway = new Gateway({});
		const logs = [];
		const timeoutError = new Error('Call to device timed out');

		timeoutError.code = 'timeout';
		gateway.debug = function() {
			logs.push(Array.prototype.slice.call(arguments));
		};
		gateway._findDeveloperKey = function() {
			return Promise.resolve();
		};
		gateway._updateDeviceList = function() {
			return Promise.resolve();
		};

		return gateway.initCallback()
			.then(() => {
				assert.strictEqual(intervals.length, 1);
				assert.strictEqual(intervals[0].delay, 30 * 60 * 1000);

				delete gateway._updateDeviceList;
				gateway.call = function() {
					return Promise.reject(timeoutError);
				};
				intervals[0].handler();
				return nextTurn();
			})
			.then(() => {
				assert.strictEqual(unhandled.length, 0);
				assert.strictEqual(logs.length, 1);
				assert.strictEqual(logs[0][0], 'Gateway device list refresh failed');
				assert.strictEqual(logs[0][1], timeoutError);

				return gateway._updateDeviceList().then(function() {
					throw new Error('Explicit device-list updates must reject');
				}, function(error) {
					assert.strictEqual(error, timeoutError);
					assert.strictEqual(error.code, 'timeout');
				});
			})
			.then(() => {
				const syncError = new Error('synchronous device-list failure');
				let caught;

				gateway._updateDeviceList = function() {
					throw syncError;
				};
				assert.doesNotThrow(function() {
					intervals[0].handler();
				});
				assert.strictEqual(logs.length, 2);
				assert.strictEqual(logs[1][0], 'Gateway device list refresh failed');
				assert.strictEqual(logs[1][1], syncError);

				try {
					gateway._updateDeviceList();
				} catch(error) {
					caught = error;
				}

				assert.strictEqual(caught, syncError);
				return nextTurn();
			})
			.then(() => {
				assert.strictEqual(unhandled.length, 0);
			});
	})
		.then(value => {
			process.removeListener('unhandledRejection', onUnhandledRejection);
			return value;
		}, error => {
			process.removeListener('unhandledRejection', onUnhandledRejection);
			throw error;
		});
}

function run() {
	testDeveloperApiTeardown();
	testDeveloperApiSendErrors();
	testDeveloperApiCloseErrors();
	testDeveloperApiSocketErrors();
	return testGatewayDeviceListRefresh();
}

run()
	.then(() => {
		process.stdout.write('gateway lifecycle regression harness passed\n');
	})
	.catch(error => {
		process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
		process.exitCode = 1;
	});
