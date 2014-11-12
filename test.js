'use strict';
var assert = require('assert');
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
