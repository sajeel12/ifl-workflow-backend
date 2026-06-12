// Boot smoke-test — import the route layer (and, transitively, every wired
// controller/service) to catch module-load failures BEFORE PM2 does:
// undefined imports, bad references (e.g. the "upload is not defined" that
// crashed startup after the sajeel merge), syntax/eval errors in route files.
//
// It does NOT connect to the database — Sequelize connects lazily, so importing
// models is side-effect-free here. Fast and safe to run in CI or pre-push.
//
//   node scripts/smoke-routes.mjs   →   exit 0 = clean, exit 1 = a route layer
//                                        failed to load (prints the stack).

const targets = [
    '../src/routes/api.js',
    '../src/routes/admin.js',
];

// Surface any async module-load rejection (the upload bug surfaced this way).
let asyncFailure = null;
process.on('unhandledRejection', (err) => { asyncFailure = err; });

let failed = false;
for (const t of targets) {
    try {
        await import(t);
        console.log('ok    ' + t);
    } catch (e) {
        failed = true;
        const stack = (e && e.stack) ? e.stack.split('\n').slice(0, 5).join('\n      ') : String(e);
        console.error('FAIL  ' + t + '\n      ' + stack);
    }
}

// Give any queued microtask rejections a tick to fire.
await new Promise(r => setTimeout(r, 50));
if (asyncFailure) {
    failed = true;
    const stack = (asyncFailure.stack || String(asyncFailure)).split('\n').slice(0, 5).join('\n      ');
    console.error('FAIL  (unhandled rejection during module load)\n      ' + stack);
}

console.log(failed ? '\nRoute layer FAILED to load.' : '\nRoute layer loaded cleanly.');
process.exit(failed ? 1 : 0);
