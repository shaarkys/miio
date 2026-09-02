'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const path = require('path');

const NETWORK_PATH = path.resolve(__dirname, '..', 'lib', 'network.js');
const DEVICE_ID = 0x12345678;

class FakeSocket extends EventEmitter {
	constructor() {
		super();

		this.bindCalls = 0;
		this.broadcastCalls = [];
		this.closeCalls = 0;
		this.sendCalls = 0;
		this.messageListenerAtSend = false;
	}

	bind(callback) {
		this.bindCalls++;
		setImmediate(callback);
	}

	setBroadcast(enabled) {
		this.broadcastCalls.push(enabled);
	}

	address() {
		return { port: 49152 };
	}

	send(data, offset, length, port, address, callback) {
		const reply = Buffer.from(data.slice(offset, offset + length));

		this.sendCalls++;
		this.messageListenerAtSend = this.listenerCount('message') > 0;
		reply.writeUInt32BE(DEVICE_ID, 8);
		reply.writeUInt32BE(Math.floor(Date.now() / 1000), 12);

		setImmediate(() => {
			this.emit('message', reply, {
				address: address,
				port: port
			});
			callback(null);
		});
	}

	close() {
		this.closeCalls++;
	}
}

function loadNetwork(socket) {
	const originalLoad = Module._load;
	let network;

	delete require.cache[NETWORK_PATH];
	Module._load = function(request, parent, isMain) {
		if(parent && parent.filename === NETWORK_PATH && request === 'dgram') {
			return {
				createSocket: function() {
					return socket;
				}
			};
		}

		return originalLoad.apply(this, arguments);
	};

	try {
		network = require(NETWORK_PATH);
	} finally {
		Module._load = originalLoad;
	}

	return network;
}

function testImmediateHandshakeReply() {
	const socket = new FakeSocket();
	const network = loadNetwork(socket);
	const reference = network.ref();

	assert.strictEqual(socket.bindCalls, 1, 'socket must bind synchronously during initialization');
	assert.strictEqual(socket.listenerCount('error'), 1, 'socket error handler must be installed synchronously');
	assert.strictEqual(socket.listenerCount('message'), 1, 'receive handler must be installed synchronously');

	return network.findDeviceViaAddress({
		address: '192.0.2.1',
		port: 54321,
		token: '00112233445566778899aabbccddeeff',
		model: 'test.vacuum'
	})
		.then(device => {
			assert.strictEqual(socket.sendCalls, 1);
			assert.strictEqual(socket.messageListenerAtSend, true);
			assert.strictEqual(device.id, DEVICE_ID);
			assert.strictEqual(device.model, 'test.vacuum');
			assert.deepStrictEqual(socket.broadcastCalls, [ true ]);

			reference.release();
			assert.strictEqual(socket.closeCalls, 1);
		})
		.catch(error => {
			reference.release();
			throw error;
		});
}

testImmediateHandshakeReply()
	.then(() => {
		process.stdout.write('network immediate-handshake regression harness passed\n');
	})
	.catch(error => {
		process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
		process.exitCode = 1;
	});
