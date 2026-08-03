#!/usr/bin/env node
// server/manage-users.js — admin CLI for Tier 1 accounts + project ACL.
//
// Usage (run on the server, in the repo root):
//   NODE_PATH=texlyre/node_modules node server/manage-users.js create-user <username>
//       (prompts for password)
//   node server/manage-users.js create-user <username> <password>
//   node server/manage-users.js list-users
//   node server/manage-users.js delete-user <username>
//   node server/manage-users.js list-projects
//   node server/manage-users.js share <projectId> <username>
//   node server/manage-users.js unshare <projectId> <username>
//   node server/manage-users.js register-project <projectId> <owner> [name]

const readline = require('node:readline');
const auth = require('./auth');

function promptPassword(username) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Password for ${username}: `, (pw) => {
      rl.close();
      resolve(pw);
    });
  });
}

(async () => {
  const [cmd, arg1, arg2, arg3] = process.argv.slice(2);

  switch (cmd) {
    case 'create-user': {
      if (!arg1) return console.error('usage: create-user <username> [password]');
      let password = arg2;
      if (!password) password = await promptPassword(arg1);
      const result = auth.registerUser(arg1, password, undefined);
      if (result.ok) console.log(`created user: ${arg1}`);
      else console.error(`ERROR: ${result.error}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'list-users': {
      const { USERS_FILE } = require('./auth');
      const users = JSON.parse(require('node:fs').readFileSync(USERS_FILE, 'utf8'));
      for (const name of Object.keys(users)) console.log(name);
      break;
    }
    case 'delete-user': {
      if (!arg1) return console.error('usage: delete-user <username>');
      const fs = require('node:fs');
      const { USERS_FILE } = require('./auth');
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (!users[arg1]) return console.error(`user not found: ${arg1}`);
      delete users[arg1];
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      console.log(`deleted user: ${arg1}`);
      break;
    }
    case 'list-projects': {
      const fs = require('node:fs');
      const { PROJECTS_FILE } = require('./auth');
      const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      for (const [id, p] of Object.entries(projects)) {
        console.log(`${id}  owner=${p.owner}  members=[${p.members.join(', ')}]  name=${p.name}`);
      }
      break;
    }
    case 'register-project': {
      if (!arg1 || !arg2) return console.error('usage: register-project <projectId> <owner> [name]');
      const result = auth.registerProject(arg1, arg3 || '', arg2);
      if (result.ok) console.log(`project registered: ${arg1} (owner: ${arg2})`);
      else console.error(`ERROR: ${result.error}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'share': {
      if (!arg1 || !arg2) return console.error('usage: share <projectId> <username>');
      const fs = require('node:fs');
      const { PROJECTS_FILE } = require('./auth');
      const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      const owner = projects[arg1]?.owner;
      if (!owner) return console.error(`project not found: ${arg1}`);
      const result = auth.shareProject(arg1, arg2, owner);
      if (result.ok) console.log(`shared ${arg1} with ${arg2}`);
      else console.error(`ERROR: ${result.error}`);
      break;
    }
    case 'unshare': {
      if (!arg1 || !arg2) return console.error('usage: unshare <projectId> <username>');
      const fs = require('node:fs');
      const { PROJECTS_FILE } = require('./auth');
      const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      const owner = projects[arg1]?.owner;
      if (!owner) return console.error(`project not found: ${arg1}`);
      const result = auth.unshareProject(arg1, arg2, owner);
      if (result.ok) console.log(`unshared ${arg1} from ${arg2}`);
      else console.error(`ERROR: ${result.error}`);
      break;
    }
    default:
      console.log(`usage:
  create-user <username> [password]
  list-users
  delete-user <username>
  list-projects
  register-project <projectId> <owner> [name]
  share <projectId> <username>
  unshare <projectId> <username>`);
      process.exit(1);
  }
})();
