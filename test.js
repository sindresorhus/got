'use strict';
var assert = require('assert');
var got = require('./index');

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

it('should should return status code as error when not 200', function (done) {
	got('http://sindresorhus.com/sfsadfasdfadsga', function (err, data) {
		assert.strictEqual(err, 404);
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
