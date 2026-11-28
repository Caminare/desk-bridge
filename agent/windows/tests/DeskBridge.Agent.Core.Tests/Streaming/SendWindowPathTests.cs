using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Streaming;

/// <summary>
/// <see cref="SendWindow"/> driving a simulated path: a single bottleneck of a given rate (bytes per ms) plus a
/// fixed base round trip, fed by a capture loop that keeps only the freshest unsent frame (like
/// <see cref="FrameMailbox"/>). The numbers come from the 2026-11-27 field logs: a phone path delivering about
/// 50 KB/s while scrolling produced 20 KB deltas at 24 to 30 fps and multi-second delays.
/// </summary>
public class SendWindowPathTests
{
    private sealed class SimPath(double bytesPerMs, long baseRttMs)
    {
        private readonly List<(long Seq, double AckAt)> _pending = [];
        private double _linkFreeAt;

        public double BytesPerMs { get; set; } = bytesPerMs;

        public void Send(long seq, int bytes, long now)
        {
            double start = Math.Max(now, _linkFreeAt);
            _linkFreeAt = start + bytes / BytesPerMs;
            _pending.Add((seq, _linkFreeAt + baseRttMs));
        }

        /// <summary>The link carries nothing for <paramref name="ms"/>: everything still queued arrives that much later.</summary>
        public void Freeze(long now, long ms)
        {
            for (int i = 0; i < _pending.Count; i++)
                if (_pending[i].AckAt > now) _pending[i] = (_pending[i].Seq, _pending[i].AckAt + ms);
            _linkFreeAt = Math.Max(_linkFreeAt, now) + ms;
        }

        public IEnumerable<long> AcksDue(long now)
        {
            var due = _pending.Where(p => p.AckAt <= now).Select(p => p.Seq).ToList();
            _pending.RemoveAll(p => p.AckAt <= now);
            return due;
        }
    }

    private sealed class Run
    {
        public readonly SendWindow Window = new();
        public readonly SimPath Path;
        public readonly List<(long SentAt, double SampleMs, int Bytes)> Acked = [];
        public readonly List<(long At, int Bytes)> Sent = [];
        public int Produced;
        private readonly Dictionary<long, (long At, int Bytes)> _bySeq = [];
        private int? _mailbox;
        private long _seq;
        private long _now;

        public Run(double bytesPerMs, long baseRttMs) => Path = new SimPath(bytesPerMs, baseRttMs);

        /// <summary>Runs until <paramref name="untilMs"/>, capturing a frame of <paramref name="bytes"/> at <paramref name="fps"/>.</summary>
        public Run For(long untilMs, int fps, int bytes)
        {
            long interval = 1000 / fps;
            for (; _now < untilMs; _now++)
            {
                foreach (long seq in Path.AcksDue(_now))
                {
                    if (Window.OnAck(seq, false, _now) is { } s) Acked.Add((_bySeq[seq].At, s.SampleMs, s.Bytes));
                }
                if (_now % interval == 0) { _mailbox = bytes; Produced++; }
                if (_mailbox is int b && Window.CanSend(_now, b))
                {
                    _seq++;
                    Window.OnSent(_seq, b, _now);
                    Path.Send(_seq, b, _now);
                    _bySeq[_seq] = (_now, b);
                    Sent.Add((_now, b));
                    _mailbox = null;
                }
            }
            return this;
        }

        public long Now => _now;

        public double MedianDelay(long fromMs, long toMs) => Percentile(Delays(fromMs, toMs), 0.5);
        public double P90Delay(long fromMs, long toMs) => Percentile(Delays(fromMs, toMs), 0.9);
        public double MaxDelay(long fromMs, long toMs) => Delays(fromMs, toMs).Max();

        /// <summary>Bytes the path delivered for frames sent in the interval, per ms.</summary>
        public double Goodput(long fromMs, long toMs) =>
            Acked.Where(a => a.SentAt >= fromMs && a.SentAt < toMs).Sum(a => (double)a.Bytes) / (toMs - fromMs);

        public int SentBetween(long fromMs, long toMs) => Sent.Count(s => s.At >= fromMs && s.At < toMs);

        private List<double> Delays(long fromMs, long toMs)
        {
            var d = Acked.Where(a => a.SentAt >= fromMs && a.SentAt < toMs).Select(a => a.SampleMs).ToList();
            Assert.NotEmpty(d);
            return d;
        }

        private static double Percentile(List<double> values, double p)
        {
            values.Sort();
            return values[(int)Math.Min(values.Count - 1, Math.Floor(p * values.Count))];
        }
    }

    // A slow path: 50 KB/s, 40 ms base. A 20 KB delta takes 400 ms on the wire, so the best possible delay is
    // about 440 ms; anything well beyond that is a standing queue the sender built.
    private const double Slow = 50;      // bytes per ms
    private const double Fast = 5000;    // 40 Mbit/s
    private const long Base = 40;
    private const int Delta = 20_000;
    private const double SlowBestDelay = Base + Delta / Slow;  // 440 ms
    private const double QueueAllowanceMs = 250;

    [Fact]
    public void Slow_path_keeps_the_standing_queue_small_without_wasting_the_link()
    {
        var run = new Run(Slow, Base).For(20_000, fps: 30, Delta);
        Assert.InRange(run.MedianDelay(5_000, 20_000), 0, SlowBestDelay + QueueAllowanceMs);
        Assert.True(run.Goodput(5_000, 19_000) >= 0.85 * Slow, $"goodput {run.Goodput(5_000, 19_000):F1} B/ms");
    }

    [Fact]
    public void Fast_path_sends_every_frame()
    {
        var run = new Run(Fast, Base).For(10_000, fps: 30, 100_000);
        Assert.True(run.SentBetween(2_000, 10_000) >= 0.95 * 8 * 30, $"sent {run.SentBetween(2_000, 10_000)}");
        Assert.InRange(run.MedianDelay(2_000, 10_000), 0, Base + 100_000 / Fast + 50);
    }

    [Fact]
    public void A_quiet_screen_does_not_inflate_the_window_before_a_burst()
    {
        // The field logs: 1 to 2 KB frames acked quickly grew the window to 8 MB in about 5 s, and scrolling
        // then queued seconds of frames.
        var run = new Run(Slow, Base).For(10_000, fps: 10, 2_000).For(20_000, fps: 30, Delta);
        Assert.InRange(run.MaxDelay(12_000, 20_000), 0, SlowBestDelay + 2 * QueueAllowanceMs);
        Assert.InRange(run.MedianDelay(12_000, 20_000), 0, SlowBestDelay + QueueAllowanceMs);
    }

    [Fact]
    public void Small_quick_frames_on_a_quiet_screen_do_not_hold_back_a_burst_on_a_fast_path()
    {
        var run = new Run(Fast, Base).For(10_000, fps: 10, 2_000).For(12_000, fps: 30, 100_000);
        Assert.True(run.SentBetween(10_000, 12_000) >= 0.9 * 60, $"sent {run.SentBetween(10_000, 12_000)}");
    }

    [Fact]
    public void Follows_a_path_that_drops_to_a_third_of_its_capacity()
    {
        var run = new Run(Slow * 3, Base).For(10_000, fps: 30, Delta);
        run.Path.BytesPerMs = Slow;
        run.For(25_000, fps: 30, Delta);
        Assert.InRange(run.MedianDelay(13_000, 25_000), 0, SlowBestDelay + QueueAllowanceMs);
        Assert.InRange(run.MaxDelay(15_000, 25_000), 0, SlowBestDelay + 2 * QueueAllowanceMs);
    }

    [Fact]
    public void Recovers_full_rate_when_the_path_speeds_up_again()
    {
        var run = new Run(Slow, Base).For(10_000, fps: 30, Delta);
        run.Path.BytesPerMs = Fast;
        run.For(15_000, fps: 30, Delta);
        Assert.True(run.SentBetween(12_000, 15_000) >= 0.95 * 90, $"sent {run.SentBetween(12_000, 15_000)}");
    }

    [Fact]
    public void Does_not_pour_frames_into_a_path_that_stopped_delivering()
    {
        var run = new Run(Slow * 3, Base).For(10_000, fps: 30, Delta);
        run.Path.Freeze(run.Now, 3_000);
        run.For(13_000, fps: 30, Delta);
        Assert.True(run.SentBetween(10_500, 13_000) <= 1, $"sent {run.SentBetween(10_500, 13_000)} frames into a stalled path");
        run.For(20_000, fps: 30, Delta);
        Assert.InRange(run.MedianDelay(15_000, 20_000), 0, Base + Delta / (Slow * 3) + QueueAllowanceMs);
    }

    [Fact]
    public void Does_not_dump_a_burst_of_frames_before_the_first_ack()
    {
        var run = new Run(Slow, Base).For(3_000, fps: 30, Delta);
        Assert.InRange(run.MaxDelay(0, 2_000), 0, SlowBestDelay + 2 * QueueAllowanceMs);
    }

    [Fact]
    public void A_burst_after_a_quiet_screen_is_paced_from_its_first_frame()
    {
        var run = new Run(Slow, Base).For(10_000, fps: 10, 2_000).For(14_000, fps: 30, Delta);
        Assert.InRange(run.MaxDelay(10_000, 11_000), 0, SlowBestDelay + 2 * QueueAllowanceMs);
    }

    [Fact]
    public void A_long_fast_path_is_not_capped_by_the_round_trip()
    {
        // AGENTS.md: a fixed small window would cap fps at window / RTT on a long path.
        var run = new Run(Fast, 300).For(10_000, fps: 30, 100_000);
        Assert.True(run.SentBetween(3_000, 10_000) >= 0.95 * 7 * 30, $"sent {run.SentBetween(3_000, 10_000)}");
    }

    [Fact]
    public void One_late_ack_does_not_cost_a_fast_path_its_frame_rate()
    {
        var run = new Run(Fast, Base).For(5_000, fps: 30, 100_000);
        run.Path.Freeze(run.Now, 400);
        run.For(10_000, fps: 30, 100_000);
        Assert.True(run.SentBetween(6_000, 10_000) >= 0.95 * 4 * 30, $"sent {run.SentBetween(6_000, 10_000)}");
    }

    [Fact]
    public void Small_deltas_recover_quickly_after_an_occasional_large_keyframe()
    {
        // 1 KB deltas at 30 fps plus a 150 KB keyframe every 10 s: about 45 KB/s on a 50 KB/s path. Each
        // keyframe occupies the link for 3 s; afterwards the deltas must flow without a standing queue.
        var run = new Run(Slow, Base);
        for (long k = 0; k < 40_000; k += 10_000)
        {
            run.For(k + 34, fps: 30, 150_000);
            run.For(k + 10_000, fps: 30, 1_000);
        }
        for (long k = 0; k < 40_000; k += 10_000)
            Assert.InRange(run.MedianDelay(k + 5_000, k + 10_000), 0, Base + 1_000 / Slow + QueueAllowanceMs);
    }

    [Fact]
    public void Slow_path_queues_at_most_one_frame_behind_another()
    {
        // Growth after a cut periodically admits a second frame (440 -> 840 ms here) before the next cut.
        // Preventing that needs a link-rate estimate, which for lone frames includes the propagation delay and
        // would cap a long fast path at one frame per round trip; one queued frame is the accepted bound.
        var run = new Run(Slow, Base).For(30_000, fps: 30, Delta);
        Assert.InRange(run.P90Delay(5_000, 30_000), 0, SlowBestDelay + Delta / Slow + 50);
        Assert.InRange(run.MedianDelay(5_000, 30_000), 0, SlowBestDelay + QueueAllowanceMs);
    }

    [Fact]
    public void A_grown_window_collapses_quickly_when_a_fast_path_turns_slow()
    {
        // The wifi field run: healthy for about 15 s, then seconds of delay once the path slowed.
        var run = new Run(Fast, Base).For(10_000, fps: 30, 100_000);
        run.Path.BytesPerMs = Slow;
        run.For(30_000, fps: 30, Delta);
        Assert.InRange(run.MaxDelay(13_000, 30_000), 0, SlowBestDelay + 2 * QueueAllowanceMs);
        Assert.InRange(run.P90Delay(12_000, 30_000), 0, SlowBestDelay + QueueAllowanceMs);
    }

    [Fact]
    public void A_window_grown_before_a_quiet_spell_does_not_flood_a_path_that_slowed_meanwhile()
    {
        var run = new Run(Fast, Base).For(10_000, fps: 30, 100_000).For(20_000, fps: 10, 1_000);
        run.Path.BytesPerMs = Slow;
        run.For(40_000, fps: 30, Delta);
        Assert.InRange(run.MaxDelay(23_000, 40_000), 0, SlowBestDelay + 2 * QueueAllowanceMs);
        Assert.InRange(run.P90Delay(22_000, 40_000), 0, SlowBestDelay + QueueAllowanceMs);
    }

    [Fact]
    public void A_long_fast_path_regains_its_frame_rate_after_a_cut()
    {
        var run = new Run(Fast, 300).For(10_000, fps: 30, 100_000);
        run.Path.Freeze(run.Now, 1_500);
        run.For(25_000, fps: 30, 100_000);
        Assert.True(run.SentBetween(17_000, 25_000) >= 0.95 * 8 * 30, $"sent {run.SentBetween(17_000, 25_000)}");
    }

    [Fact]
    public void Keeps_the_queue_small_through_overload_longer_than_the_baseline_window()
    {
        var run = new Run(Slow, Base).For(40_000, fps: 30, Delta);
        for (long from = 5_000; from < 40_000; from += 5_000)
            Assert.InRange(run.MedianDelay(from, from + 5_000), 0, SlowBestDelay + QueueAllowanceMs);
    }
}
