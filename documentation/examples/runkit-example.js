const got = require("got");
const ISS = "http://api.open-notify.org/iss-now.json";

(await got(ISS).json()).iss_position;
