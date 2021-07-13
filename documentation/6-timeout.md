[> Back to homepage](../readme.md#documentation)

## Timeout options

Source code: [`source/core/timed-out.ts`](../source/core/timed-out.ts)

It is a good practice to set a timeout to prevent hanging requests.\
By default, there is no timeout set.

**All numbers refer to milliseconds.**

```js
import got from 'got';

const {timings} = await got('https://example.com', {
	timeout: {
		lookup: 100,
		connect: 50,
		secureConnect: 50,
		socket: 1000,
		send: 10000,
		response: 1000
	}
});

// Alternatively:
const {timings} = await got('https://example.com', {
	timeout: {
		request: 10000
	}
});

console.log(timings);
// {
// 	start: 1625474926602,
// 	socket: 1625474926605,
// 	lookup: 1625474926610,
// 	connect: 1625474926617,
// 	secureConnect: 1625474926631,
// 	upload: 1625474926631,
// 	response: 1625474926638,
// 	end: 1625474926642,
// 	error: undefined,
// 	abort: undefined,
// 	phases: {
// 		wait: 3,
// 		dns: 5,
// 		tcp: 7,
// 		tls: 14,
// 		request: 0,
// 		firstByte: 7,
// 		download: 4,
// 		total: 40
// 	}
// }
```

### `timeout`

**Type: `object`**

This object describes the maximum allowed time for particular events.

#### `lookup`

**Type: `number`**

Starts when a socket is assigned.\
Ends when the hostname has been resolved.

Does not apply when using a Unix domain socket.\
Does not apply when passing an IP address.

It is preferred to not use any greater value than `100`.

#### `connect`

**Type: `number`**

Starts when lookup completes.\
Ends when the socket is fully connected.

If `lookup` does not apply to the request, this event starts when the socket is assigned and ends when the socket is connected.

#### `secureConnect`

**Type: `number`**

Starts when `connect` completes.\
Ends when the handshake process completes.

This timeout applies only to HTTPS requests.

#### `socket`

**Type: `number`**

Starts when the socket is connected.\
Resets when new data are received.

It is the same as [`request.setTimeout(timeout)`](https://nodejs.org/api/http.html#http_request_settimeout_timeout_callback).

#### `send`

**Type: `number`**

Starts when the socket is connected.\
Ends when all data have been written to the socket.

**Note:**
> - This does not assure the data have been received by the other end!
> - It only assures that the data have been passed to the underlying OS.

#### `response`

**Type: `number`**

Starts when request has been flushed.\
Ends when the headers are received.

#### ~~`read`~~

**Type: `number`**

Starts when the headers are received.\
Ends when the response's `end` event fires.

**Note:**
> - This timeout is blocked by https://github.com/nodejs/node/issues/35923

#### `request`

**Type: `number`**

Starts when the request is initiated.\
Ends when the response's `end` event fires.

In other words, this is the global timeout.
