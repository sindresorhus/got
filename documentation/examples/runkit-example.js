import got from 'got';

const issUrl = 'http://api.open-notify.org/iss-now.json';

const {iss_position: issPosition} = await got(issUrl).json();

console.log(issPosition);
//=> {latitude: '20.4956', longitude: '42.2216'}
