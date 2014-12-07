/* global describe, it, before, after */
'use strict';
var assert = require('assert');
var http = require('http');
var got = require('./');

it('should do HTTP request', function (done) {
	got('http://google.com', function (err, data) {
		if (err) {
			console.error(err);
			assert(false);
			return;
		}

		assert(/google/.test(data));
		done();
	});
});

it('should do HTTPS request', function (done) {
	got('https://google.com', function (err, data) {
		if (err) {
			console.error(err);
			assert(false);
			return;
		}

		assert(/google/.test(data));
		done();
	});
});

it('should should return status code as error code and response object when not 200', function (done) {
	got('http://sindresorhus.com/sfsadfasdfadsga', function (err, data, res) {
		assert.ok(res.headers);
		assert.strictEqual(err.code, 404);
		assert.ok(/<!DOCTYPE html>/.test(data));
		done();
	});
});

it('should support optional options', function (done) {
	got('http://sindresorhus.com', {method: 'HEAD'}, function (err, data) {
		assert(!err, err);
		assert(!data, data);
		done();
	});
});

it('should get headers only with HEAD method', function (done) {
	got('http://google.com', {method: 'HEAD'}, function (err, data, res) {
		assert(!data, data);
		assert.ok(res.headers);
		done();
	});
});

it('should support gzip', function (done) {
	got('http://sindresorhus.com', function (err, data) {
		assert(!err, err);
		assert(/^<!doctype html>/.test(data));
		done();
	});
});

it('should return a buffer if encoding is set to null', function (done) {
	got('http://google.com', {encoding: null}, function (err, data) {
		assert(!err, err);
		assert.ok(Buffer.isBuffer(data));
		done();
	});
});

it('should return a readable stream without a callback', function (done) {
	var stream = got('http://google.com');

	var data = '';
	stream.on('data', function (chunk) {
		data += chunk;
	});
	stream.on('end', function () {
		assert.ok(/google/.test(data));
		done();
	});
});

it('should proxy errors to the stream', function (done) {
	var stream = got('http://sindresorhus.com/sfsadfasdfadsga');

	stream.on('error', function (error) {
		assert.strictEqual(error.code, 404);
		done();
	});
});

it('should support timeout option', function (done) {
	var stream = got('http://sindresorhus.com/', {timeout: 1});

	stream.on('error', function (error) {
		assert.strictEqual(error.code, 'ETIMEDOUT');
		done();
	});
});

describe('POST', function () {
	var server;

	before(function (done) {
		server = http.createServer(function (req, res) {
			req.pipe(res);
		});
		server.listen(8081, done);
	});

	after(function (done) {
		server.close(done);
	});

	it('should support string as body option', function (done) {
		got('http://0.0.0.0:8081', {body: 'string'}, function (err, data) {
			assert.ifError(err);
			assert.equal(data, 'string');
			done();
		});
	});

	it('should support Buffer as body option', function (done) {
		got('http://0.0.0.0:8081', {body: new Buffer('string')}, function (err, data) {
			assert.ifError(err);
			assert.equal(data, 'string');
			done();
		});
	});

	it('should take data from options.body in stream mode', function (done) {
		got.post('http://0.0.0.0:8081', {body: 'Hello'})
			.on('error', done)
			.on('data', function (chunk) {
				assert.equal(chunk, 'Hello');
				done();
			});
	});

	it('should throw an error on options.body and write operations', function (done) {
		assert.throws(function () {
			got.post('http://0.0.0.0:8081', {body: 'Hello'})
				.end('Hello');
		}, 'got\'s stream is not writable when options.body is used');

		assert.throws(function () {
			got.post('http://0.0.0.0:8081', {body: 'Hello'})
				.write('Hello');
		}, 'got\'s stream is not writable when options.body is used');

		done();
	});

	it('should be a writeable stream on POST', function (done) {
		got.post('http://0.0.0.0:8081')
			.on('error', done)
			.on('data', function (chunk) {
				assert.equal(chunk, 'Hello');
				done();
			})
			.end('Hello');
	});

	it('should be a writeable stream on PUT', function (done) {
		got.put('http://0.0.0.0:8081')
			.on('error', done)
			.on('data', function (chunk) {
				assert.equal(chunk, 'Hello');
				done();
			})
			.end('Hello');
	});
});
