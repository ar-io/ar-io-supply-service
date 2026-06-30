//! HTTP entry point for the AR.IO token supply service.
//!
//! Loads the Express app from `./app.js` and starts listening. The app is
//! split out so integration tests can mount it on a random port without
//! involving this file.

import pino from "pino";

import app, { config } from "./app.js";

const log = pino({ level: config.logLevel });

app.listen(config.port, () => {
  log.info({ port: config.port }, "ar.io supply service listening");
});
