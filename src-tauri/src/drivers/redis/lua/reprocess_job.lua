--[[
  BullMQ's own `reprocessJob`, flattened.

  Vendored verbatim from taskforcesh/bullmq rather than reimplemented, and the
  reason is the parent branch below. A job produced by a Flow has to be put back
  into `<parent>:dependencies` when it is retried; a retry written by hand as
  ZREM + LPUSH looks correct, moves the job, and leaves the parent waiting on a
  dependency that will never be satisfied again. That failure surfaces days
  later as a parent job that never completes, with nothing in the logs tying it
  to the retry that caused it.

  The other three are the same kind of silence:

    - the marker ZADD is what wakes a worker blocked on the marker key. Without
      it the job sits in `wait` until the next drain poll and the retry reads as
      having done nothing.
    - `isQueuePausedOrMaxed` reads `paused` and `concurrency` off the meta hash.
      Since v5 `paused` is a meta field, not a list, so a paused queue is not
      visible from the key layout alone.
    - the events XADD is what `QueueEvents` listeners and this app's own trace
      timeline read. A retry that skips it is invisible to both.

  Source: https://github.com/taskforcesh/bullmq
    src/commands/reprocessJob-8.lua
    src/commands/includes/{addJobInTargetList,addBaseMarkerIfNeeded,
                           getOrSetMaxEvents,isQueuePausedOrMaxed}.lua

  Upstream keeps the includes as separate files and inlines them at build time.
  They are inlined here in dependency order instead. When upgrading: re-fetch
  all five files, re-flatten, and check that the KEYS/ARGV list below still
  matches `retryFinishedJob` in src/classes/redis-queue-backend.ts. The key
  order is positional and nothing will complain if it drifts.

  Input:
    KEYS[1] job key
    KEYS[2] events stream
    KEYS[3] job state (the failed or completed zset)
    KEYS[4] wait key
    KEYS[5] meta
    KEYS[6] paused key
    KEYS[7] active key
    KEYS[8] marker key

    ARGV[1] job.id
    ARGV[2] (job.opts.lifo ? 'R' : 'L') + 'PUSH'
    ARGV[3] propVal - failedReason/returnvalue
    ARGV[4] prev state - failed/completed
    ARGV[5] reset attemptsMade - "1" or "0"
    ARGV[6] reset attemptsStarted - "1" or "0"

  Output:
     1 means the operation was a success
    -1 means the job does not exist
    -3 means the job was not found in the expected set.
]]
local rcall = redis.call;

local function getOrSetMaxEvents(metaKey)
  local maxEvents = rcall("HGET", metaKey, "opts.maxLenEvents")
  if not maxEvents then
    maxEvents = 10000
    rcall("HSET", metaKey, "opts.maxLenEvents", maxEvents)
  end
  return maxEvents
end

local function addBaseMarkerIfNeeded(markerKey, isPausedOrMaxed)
  if not isPausedOrMaxed then
    rcall("ZADD", markerKey, 0, "0")
  end
end

local function addJobInTargetList(targetKey, markerKey, pushCmd, isPausedOrMaxed, jobId)
  rcall(pushCmd, targetKey, jobId)
  addBaseMarkerIfNeeded(markerKey, isPausedOrMaxed)
end

local function isQueuePausedOrMaxed(queueMetaKey, activeKey)
  local queueAttributes = rcall("HMGET", queueMetaKey, "paused", "concurrency")

  if queueAttributes[1] then
    return true
  else
    if queueAttributes[2] then
      local activeCount = rcall("LLEN", activeKey)
      return activeCount >= tonumber(queueAttributes[2])
    end
  end
  return false
end

local jobKey = KEYS[1]
if rcall("EXISTS", jobKey) == 1 then
  local jobId = ARGV[1]
  if (rcall("ZREM", KEYS[3], jobId) == 1) then
    local attributesToRemove = {}

    if ARGV[5] == "1" then
      table.insert(attributesToRemove, "atm")
    end

    if ARGV[6] == "1" then
      table.insert(attributesToRemove, "ats")
    end

    rcall("HDEL", jobKey, "finishedOn", "processedOn", ARGV[3], unpack(attributesToRemove))

    local isPausedOrMaxed = isQueuePausedOrMaxed(KEYS[5], KEYS[7])
    addJobInTargetList(KEYS[4], KEYS[8], ARGV[2], isPausedOrMaxed, jobId)

    local parentKey = rcall("HGET", jobKey, "parentKey")

    if parentKey and rcall("EXISTS", parentKey) == 1 then
      if ARGV[4] == "failed" then
        if rcall("ZREM", parentKey .. ":unsuccessful", jobKey) == 1 or
          rcall("HDEL", parentKey .. ":failed", jobKey) == 1 then
          rcall("SADD", parentKey .. ":dependencies", jobKey)
        end
      else
        if rcall("HDEL", parentKey .. ":processed", jobKey) == 1 then
          rcall("SADD", parentKey .. ":dependencies", jobKey)
        end
      end
    end

    local maxEvents = getOrSetMaxEvents(KEYS[5])
    -- Emit waiting event
    rcall("XADD", KEYS[2], "MAXLEN", "~", maxEvents, "*", "event", "waiting",
      "jobId", jobId, "prev", ARGV[4]);
    return 1
  else
    return -3
  end
else
  return -1
end
