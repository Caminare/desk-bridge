using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Streaming;

public class SendWindowTests
{
    /// <summary>Sends a frame at <paramref name="t"/> and acks it <paramref name="rtt"/> ms later.</summary>
    private static long RoundTrip(SendWindow w, ref long seq, long t, int rtt, int bytes = 1000)
    {
        seq++;
        w.OnSent(seq, bytes, t);
        w.OnAck(seq, false, t + rtt);
        return t + rtt;
    }

    [Fact]
    public void Starts_open_with_256KB_window()
    {
        var w = new SendWindow();
        Assert.True(w.CanSend(0));
        Assert.Equal(262144, w.WindowBytes);
    }

    [Fact]
    public void Always_open_when_nothing_in_flight_even_for_a_huge_frame()
    {
        var w = new SendWindow();
        Assert.True(w.CanSend(0));
        w.OnSent(1, 10_000_000, 0);
        Assert.False(w.CanSend(1));
    }

    [Fact]
    public void Closes_at_byte_budget_and_reopens_on_ack()
    {
        var w = new SendWindow();
        w.OnSent(1, 200_000, 0);
        Assert.True(w.CanSend(1));
        w.OnSent(2, 100_000, 1);
        Assert.False(w.CanSend(2));
        w.OnAck(1, false, 10);
        Assert.Equal(1, w.InFlightCount);
        Assert.Equal(100_000, w.InFlightBytes);
        Assert.True(w.CanSend(10));
    }

    [Fact]
    public void Closes_at_max_in_flight()
    {
        var w = new SendWindow(maxInFlight: 3);
        for (int i = 1; i <= 3; i++) { Assert.True(w.CanSend(i)); w.OnSent(i, 10, i); }
        Assert.False(w.CanSend(4));
    }

    [Fact]
    public void Ack_is_cumulative()
    {
        var w = new SendWindow();
        w.OnSent(1, 10, 0); w.OnSent(2, 10, 1); w.OnSent(3, 10, 2);
        w.OnAck(2, false, 50);
        Assert.Equal(1, w.InFlightCount);
        Assert.Equal(10, w.InFlightBytes);
    }

    [Fact]
    public void Window_grows_by_at_least_16KB_or_10_percent_while_not_queuing()
    {
        var w = new SendWindow();
        long seq = 0, t = 0;
        t = RoundTrip(w, ref seq, t, 20);
        Assert.Equal(262144 + 26214.4, w.WindowBytes, 1);
        Assert.Equal(20, w.RttMs);
        Assert.Equal(20, w.BaselineRttMs);
        for (int i = 0; i < 200; i++) t = RoundTrip(w, ref seq, t, 20);
        Assert.Equal(8388608, w.WindowBytes); // capped at 8 MB
    }

    [Fact]
    public void Rtt_is_smoothed_and_baseline_is_the_minimum()
    {
        var w = new SendWindow();
        long seq = 0, t = 0;
        t = RoundTrip(w, ref seq, t, 100);
        t = RoundTrip(w, ref seq, t, 50);
        Assert.Equal(0.7 * 100 + 0.3 * 50, w.RttMs, 6);
        Assert.Equal(50, w.BaselineRttMs);
    }

    [Fact]
    public void Queuing_beyond_250ms_cuts_by_30_percent_at_most_once_per_rtt()
    {
        var w = new SendWindow();
        long seq = 0, t = 1000;
        t = RoundTrip(w, ref seq, t, 20); // baseline 20
        // grow a bit first so the cut is visible against the floor
        for (int i = 0; i < 30; i++) t = RoundTrip(w, ref seq, t, 20);
        double before = w.WindowBytes;
        // One big sample pulls the smoothed RTT above baseline + 250: 0.7*20 + 0.3*1500 = 464
        t = RoundTrip(w, ref seq, t, 1500);
        double afterCut = w.WindowBytes;
        Assert.Equal(before * 0.7, afterCut, 3);
        // Immediately again, within one RTT of the cut: no second cut.
        seq++;
        w.OnSent(seq, 1000, t);
        w.OnAck(seq, false, t + 1);
        Assert.Equal(afterCut, w.WindowBytes, 3);
    }

    [Fact]
    public void Window_never_drops_below_128KB()
    {
        var w = new SendWindow();
        long seq = 0, t = 1000;
        t = RoundTrip(w, ref seq, t, 10);
        for (int i = 0; i < 40; i++) t = RoundTrip(w, ref seq, t, 5000);
        Assert.True(w.WindowBytes >= 131072);
    }

    [Fact]
    public void Relay_ack_frees_the_window_but_is_not_an_rtt_sample()
    {
        var w = new SendWindow();
        w.OnSent(1, 100, 0);
        w.OnAck(1, isRelay: true, 40);
        Assert.Equal(0, w.InFlightCount);
        Assert.Equal(0, w.RttMs);
        Assert.Equal(262144, w.WindowBytes);
    }

    [Fact]
    public void Ack_for_unknown_seq_is_not_an_rtt_sample()
    {
        var w = new SendWindow();
        w.OnAck(7, false, 40);
        Assert.Equal(0, w.RttMs);
    }

    [Fact]
    public void Path_ack_reports_the_raw_sample_and_the_acked_frames_size()
    {
        var w = new SendWindow();
        w.OnSent(1, 5_000, 0);
        w.OnSent(2, 300_000, 10);
        RttSample? sample = w.OnAck(2, false, 410);
        Assert.Equal(new RttSample(Seq: 2, Bytes: 300_000, SampleMs: 400, InFlightBytesAtSend: 305_000), sample);
    }

    [Fact]
    public void A_small_frame_sent_behind_a_large_one_reports_the_bytes_queued_ahead_of_it()
    {
        var w = new SendWindow();
        w.OnSent(1, 250_000, 0);
        w.OnSent(2, 2_000, 5);
        w.OnAck(1, false, 300);
        RttSample? sample = w.OnAck(2, false, 310);
        Assert.Equal(252_000, sample?.InFlightBytesAtSend);
    }

    [Fact]
    public void Relay_ack_and_unknown_seq_report_no_sample()
    {
        var w = new SendWindow();
        w.OnSent(1, 100, 0);
        Assert.Null(w.OnAck(1, isRelay: true, 40));
        Assert.Null(w.OnAck(7, false, 50));
    }

    [Fact]
    public void Baseline_follows_a_path_that_got_slower_after_15s()
    {
        var w = new SendWindow();
        long seq = 0, t = 0;
        t = RoundTrip(w, ref seq, t, 10);
        Assert.Equal(10, w.BaselineRttMs);
        // First window ends: min of it (10) is promoted; then only slow samples follow.
        t = 16_000;
        for (int i = 0; i < 5; i++) t = RoundTrip(w, ref seq, t, 100);
        t += 16_000;
        t = RoundTrip(w, ref seq, t, 100); // rolls again: previous window min (100) becomes baseline
        Assert.Equal(100, w.BaselineRttMs);
    }

    [Fact]
    public void Stall_escape_frees_the_window_after_1_5s_or_3_rtt()
    {
        var w = new SendWindow();
        w.OnSent(1, 300_000, 0);
        Assert.False(w.CanSend(1400));
        Assert.True(w.CanSend(1501));
        Assert.Equal(0, w.InFlightCount);

        long seq = 1, t = 2000;
        t = RoundTrip(w, ref seq, t, 1000); // rtt ~1000: stall limit 3000
        seq++;
        w.OnSent(seq, 300_000, t);
        Assert.False(w.CanSend(t + 2900));
        Assert.True(w.CanSend(t + 3100));
    }

    [Fact]
    public void Reset_clears_in_flight_but_keeps_window_and_rtt()
    {
        var w = new SendWindow();
        long seq = 0, t = 0;
        t = RoundTrip(w, ref seq, t, 30);
        double win = w.WindowBytes;
        w.OnSent(99, 500, t);
        w.Reset();
        Assert.Equal(0, w.InFlightCount);
        Assert.Equal(0, w.InFlightBytes);
        Assert.Equal(win, w.WindowBytes);
        Assert.Equal(30, w.RttMs);
    }
}

public class CaptureSchedulerTests
{
    [Fact]
    public void Idle_interval_by_default()
    {
        var s = new CaptureScheduler();
        s.OnCaptureStarted(1000);
        Assert.Equal(1100, s.NextDue(1010));
    }

    [Fact]
    public void Idle_interval_is_configurable()
    {
        var s = new CaptureScheduler(idleIntervalMs: 250);
        s.OnCaptureStarted(1000);
        Assert.Equal(1250, s.NextDue(1010));
    }

    [Fact]
    public void Fast_rate_after_input_and_it_expires()
    {
        var s = new CaptureScheduler();
        s.NotifyInput(1000);
        s.OnCaptureStarted(1015); // the early capture the input asked for
        Assert.Equal(1015 + 33, s.NextDue(1020));
        Assert.Equal(1015 + 100, s.NextDue(1700)); // 600 ms of activity are over
    }

    [Fact]
    public void Input_requests_a_capture_15ms_later()
    {
        var s = new CaptureScheduler();
        s.OnCaptureStarted(1000);
        s.NotifyInput(1005);
        // Fast rate would be 1033; the settle wake-up (1020) is sooner and past the 16 ms minimum gap.
        Assert.Equal(1020, s.NextDue(1005));
    }

    [Fact]
    public void Early_wakeups_keep_a_16ms_gap_from_the_last_capture()
    {
        var s = new CaptureScheduler();
        s.OnCaptureStarted(1000);
        s.RequestImmediate(1001);
        Assert.Equal(1016, s.NextDue(1001));
    }

    [Fact]
    public void Keyframe_request_is_due_immediately_when_the_last_capture_is_old()
    {
        var s = new CaptureScheduler();
        s.OnCaptureStarted(1000);
        s.RequestImmediate(1050);
        Assert.Equal(1050, s.NextDue(1050));
    }

    [Fact]
    public void Later_wakeup_does_not_postpone_an_earlier_one()
    {
        var s = new CaptureScheduler();
        s.OnCaptureStarted(1000);
        s.RequestImmediate(1030);
        s.NotifyInput(1030); // would wake at 1045
        Assert.Equal(1030, s.NextDue(1030));
    }

    [Fact]
    public void Screen_change_keeps_the_fast_rate_for_500ms()
    {
        var s = new CaptureScheduler();
        s.OnCaptureStarted(1000);
        s.NotifyScreenChange(1000);
        Assert.Equal(1033, s.NextDue(1010));
        s.OnCaptureStarted(1490);
        Assert.Equal(1490 + 33, s.NextDue(1495));
        s.OnCaptureStarted(1520);
        Assert.Equal(1520 + 100, s.NextDue(1521));
    }

    [Fact]
    public void Capture_start_clears_the_pending_wakeup()
    {
        var s = new CaptureScheduler();
        s.RequestImmediate(500);
        s.OnCaptureStarted(510);
        Assert.Equal(610, s.NextDue(511));
    }
}
