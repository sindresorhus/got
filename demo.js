const Request = require('./dist/index').default;

const stream = new Request('https://httpbin.org/anything');

console.log(JSON.parse(JSON.stringify(stream.options)));

stream.setEncoding('utf8');
stream.on('data', console.log);
