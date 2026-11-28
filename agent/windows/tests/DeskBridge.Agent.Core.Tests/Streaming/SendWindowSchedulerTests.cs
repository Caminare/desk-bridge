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
    public void Starts_open_with_a_window_of_about_one_frame()
    {
        var w = new SendWindow();
        Assert.True(w.CanSend(0));
        Assert.Equal(16384, w.WindowBytes);
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
    public void Sends_a_frame_only_if_it_fits_in_the_window_and_reopens_on_ack()
    {
        var w = new SendWindow();
        w.OnSent(1, 10_000, 0);
        Assert.True(w.CanSend(1, 6_000));
        Assert.False(w.CanSend(1, 7_000));
        w.OnSent(2, 6_000, 1);
        w.OnAck(1, false, 10);
        Assert.Equal(1, w.InFlightCount);
        Assert.Equal(6_000, w.InFlightBytes);
        Assert.True(w.CanSend(10, 10_000));
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
    public void Window_doubles_per_round_trip_while_in_use_and_not_queuing()
    {
        var w = new SendWindow();
        long seq = 0, t = 0;
        t = RoundTrip(w, ref seq, t, 20, bytes: 16384);
        Assert.Equal(32768, w.WindowBytes);
        Assert.Equal(20, w.RttMs);
        Assert.Equal(20, w.BaselineRttMs);
        t = RoundTrip(w, ref seq, t, 20, bytes: 32768);
        Assert.Equal(65536, w.WindowBytes);
    }

    [Fact]
    public void Small_frames_on_a_quiet_screen_do_not_grow_the_window()
    {
        var w = new SendWindow();
        long seq = 0, t = 0;
        for (int i = 0; i < 100; i++) t = RoundTrip(w, ref seq, t, 20, bytes: 2_000);
        Assert.Equal(16384, w.WindowBytes);
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
    public void Queuing_beyond_250ms_resizes_the_window_to_what_the_path_delivered()
    {
        var w = new SendWindow();
        long seq = 0, t = 1000;
        // Probe up to 1 MB at a 20 ms baseline.
        for (int bytes = 16384; bytes < 1_048_576; bytes *= 2) t = RoundTrip(w, ref seq, t, 20, bytes);
        Assert.Equal(1_048_576, w.WindowBytes);
        // A full window took 1.5 s: smoothed RTT 0.7*20 + 0.3*1500 = 464, queuing 444 ms. The path delivered
        // 1 MB in 1.5 s, so a 20 ms baseline + 100 ms target holds 1048576 / 1500 * 120 = 83886 bytes.
        t = RoundTrip(w, ref seq, t, 1500, bytes: 1_048_576);
        Assert.Equal(83886.08, w.WindowBytes, 2);
        // Another frame sent before the cut implies the same size: cuts do not compound.
        t = RoundTrip(w, ref seq, t, 1500, bytes: 1_048_576);
        Assert.Equal(83886.08, w.WindowBytes, 2);
    }

    [Fact]
    public void Window_never_drops_below_16KB()
    {
        var w = new SendWindow();
        long seq = 0, t = 1000;
        t = RoundTrip(w, ref seq, t, 10);
        for (int i = 0; i < 40; i++) t = RoundTrip(w, ref seq, t, 5000);
        Assert.Equal(16384, w.WindowBytes);
    }

    [Fact]
    public void Relay_ack_frees_the_window_but_is_not_an_rtt_sample()
    {
        var w = new SendWindow();
        w.OnSent(1, 100, 0);
        w.OnAck(1, isRelay: true, 40);
        Assert.Equal(0, w.InFlightCount);
        Assert.Equal(0, w.RttMs);
        Assert.Equal(16384, w.WindowBytes);
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
    public void Relay_ack_frees_only_the_skipped_frame_not_earlier_ones_still_on_the_way()
    {
        // The relay acks a frame it could not deliver (controller backed up); earlier frames are still queued
        // towards the controller and will be acked by it.
        var w = new SendWindow();
        w.OnSent(1, 100_000, 0);
        w.OnSent(2, 1_000, 5);
        w.OnAck(2, isRelay: true, 10);
        Assert.Equal(1, w.InFlightCount);
        Assert.Equal(100_000, w.InFlightBytes);
        Assert.NotNull(w.OnAck(1, false, 900));
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
    public void Stall_escape_frees_the_window_after_5s_or_3_rtt_and_halves_it()
    {
        var w = new SendWindow();
        long seq = 0, t = 0;
        for (int bytes = 16384; bytes < 131072; bytes *= 2) t = RoundTrip(w, ref seq, t, 20, bytes);
        Assert.Equal(131072, w.WindowBytes);
        seq++;
        w.OnSent(seq, 300_000, t);
        Assert.False(w.CanSend(t + 4900));
        Assert.True(w.CanSend(t + 5001));
        Assert.Equal(0, w.InFlightCount);
        Assert.Equal(65536, w.WindowBytes);

        // On a slow path (RTT around 3 s) the escape waits 3 x RTT instead.
        t += 6000;
        for (int i = 0; i < 20; i++) t = RoundTrip(w, ref seq, t, 3000, bytes: 1_000);
        long limit = (long)(3 * w.RttMs);
        Assert.InRange(limit, 8900, 9000);
        seq++;
        w.OnSent(seq, 300_000, t);
        Assert.False(w.CanSend(t + limit - 50));
        Assert.True(w.CanSend(t + limit + 50));
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
