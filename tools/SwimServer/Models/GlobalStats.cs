namespace SwimServer;

class GlobalStats
{
    public bool Connected { get; set; }
    private long _total;
    private readonly DateTime _startTime = DateTime.UtcNow;

    public long IncrementTotal() => Interlocked.Increment(ref _total);

    public object Snapshot(int flightCount = 0)
    {
        var elapsed = (DateTime.UtcNow - _startTime).TotalSeconds;
        return new
        {
            Connected,
            Total = _total,
            Rate = elapsed > 0 ? Math.Round(_total / elapsed, 1) : 0,
            Elapsed = (DateTime.UtcNow - _startTime).ToString(@"hh\:mm\:ss"),
            Flights = flightCount,
            // Off when this host doesn't own the SWIM queues, so a dev box doesn't look
            // like a broken server (see FeedGuard).
            LiveFeed = FeedGuard.LiveFeed,
            FeedBlocked = FeedGuard.BlockedReason
        };
    }
}
