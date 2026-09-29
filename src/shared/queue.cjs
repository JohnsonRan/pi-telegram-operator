// Runs task after the previous task for the same key settles; the map only
// holds the tail while work is pending.
function enqueueKeyed(queues, key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(key, next);
  const cleanup = () => {
    if (queues.get(key) === next) queues.delete(key);
  };
  // Supplying both handlers prevents the ignored cleanup promise from
  // mirroring a task rejection as an unhandled rejection.
  next.then(cleanup, cleanup);
  return next;
}

module.exports = Object.freeze({ enqueueKeyed });
