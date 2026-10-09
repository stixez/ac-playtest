#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then((code) => {
  if (code) process.exitCode = code;
}, (error) => {
  console.error(`ac-playtest: ${error.message}`);
  process.exitCode = 1;
});
