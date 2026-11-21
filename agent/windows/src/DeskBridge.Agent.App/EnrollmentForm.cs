using DeskBridge.Agent.Core.Enrollment;

namespace DeskBridge.Agent.App;

/// <summary>What a successful enrollment produced. The secret goes straight to the DPAPI store.</summary>
internal sealed record EnrollmentOutcome(EnrollmentTarget Target, EnrollmentResult.Enrolled Credentials, string Name);

/// <summary>First-run window: paste the enrollment link (or relay address + code), pick a name, enroll.</summary>
internal sealed class EnrollmentForm : Form
{
    private readonly EnrollmentClient _client;
    private readonly string? _previousHostId;
    private readonly TextBox _link = new() { Dock = DockStyle.Fill };
    private readonly TextBox _code = new() { Dock = DockStyle.Fill, CharacterCasing = CharacterCasing.Upper, MaxLength = 12 };
    private readonly TextBox _name = new() { Dock = DockStyle.Fill, MaxLength = 64 };
    private readonly Label _status = new() { AutoSize = true, ForeColor = Color.Firebrick, MaximumSize = new Size(520, 0) };
    private readonly Button _enroll = new() { Text = "Enroll", AutoSize = true };
    private readonly Button _cancel = new() { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
    private CancellationTokenSource? _pending;

    public EnrollmentOutcome? Outcome { get; private set; }

    /// <summary>
    /// Shows the window without blocking; the task completes when it closes (null when cancelled). Must be called on
    /// the UI thread. <paramref name="ct"/> closes the window (agent quitting).
    /// </summary>
    public static Task<EnrollmentOutcome?> ShowAsync(EnrollmentClient client, string defaultName, string? previousHostId, CancellationToken ct)
    {
        var done = new TaskCompletionSource<EnrollmentOutcome?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var form = new EnrollmentForm(client, defaultName, previousHostId);
        CancellationTokenRegistration closeOnCancel = default;
        form.FormClosed += (_, _) =>
        {
            closeOnCancel.Dispose();
            done.TrySetResult(form.Outcome);
            form.Dispose();
        };
        form.Show();
        closeOnCancel = ct.Register(() =>
        {
            if (form.IsHandleCreated && !form.IsDisposed) form.BeginInvoke(form.Close);
        });
        return done.Task;
    }

    private EnrollmentForm(EnrollmentClient client, string defaultName, string? previousHostId)
    {
        _client = client;
        _previousHostId = previousHostId;

        Text = previousHostId is null ? "Add this PC to DeskBridge" : "Re-enroll this PC in DeskBridge";
        Font = SystemFonts.MessageBoxFont ?? Font;
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12);
        AcceptButton = _enroll;
        CancelButton = _cancel;
        _name.Text = defaultName;

        var layout = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, Dock = DockStyle.Fill, Width = 520 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 520));
        layout.Controls.Add(Caption("In the DeskBridge web app, open the Windows Host tab, choose \"Add a PC\" and paste the link here."));
        layout.Controls.Add(Caption("Enrollment link"));
        layout.Controls.Add(_link);
        layout.Controls.Add(Caption("Code (only if you typed the relay address above instead of the full link)"));
        layout.Controls.Add(_code);
        layout.Controls.Add(Caption("Name shown on your phone"));
        layout.Controls.Add(_name);
        layout.Controls.Add(_status);

        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill };
        buttons.Controls.Add(_cancel);
        buttons.Controls.Add(_enroll);
        layout.Controls.Add(buttons);
        Controls.Add(layout);

        _enroll.Click += async (_, _) => await EnrollAsync();
        FormClosing += (_, _) => _pending?.Cancel();
        Load += (_, _) => PrefillFromClipboard();
        Shown += (_, _) => ForceVisible();
    }

    /// <summary>
    /// Windows applies the launch's show mode (a hidden or minimized start: autostart, shortcuts,
    /// scheduled tasks) to the first window a process shows, which is this one. A PC waiting on an
    /// invisible enrollment window would look stuck, so show it again explicitly.
    /// </summary>
    private void ForceVisible()
    {
        // Not WindowState = Normal: WinForms still believes it is Normal and would skip the call.
        ShowWindow(Handle, SwRestore);
        Activate();
    }

    private const int SwRestore = 9;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool ShowWindow(nint hWnd, int nCmdShow);

    private static Label Caption(string text) =>
        new() { Text = text, AutoSize = true, MaximumSize = new Size(520, 0), Margin = new Padding(0, 8, 0, 2) };

    /// <summary>Most people just copied the link: save them a paste.</summary>
    private void PrefillFromClipboard()
    {
        try
        {
            if (!Clipboard.ContainsText()) return;
            string text = Clipboard.GetText().Trim();
            if (text.Contains("/enroll/", StringComparison.OrdinalIgnoreCase) && EnrollmentInput.TryParse(text, null, out _, out _))
            {
                _link.Text = text;
                _enroll.Select();
            }
        }
        catch (System.Runtime.InteropServices.ExternalException)
        {
            // Clipboard busy in another app: the user pastes by hand.
        }
    }

    private async Task EnrollAsync()
    {
        _status.Text = "";
        if (!EnrollmentInput.TryParse(_link.Text, _code.Text, out var target, out var error))
        {
            _status.Text = error;
            return;
        }
        string name = string.IsNullOrWhiteSpace(_name.Text) ? Environment.MachineName : _name.Text.Trim();

        SetBusy(true);
        _pending = new CancellationTokenSource();
        try
        {
            var result = await _client.EnrollAsync(target!, name, _previousHostId, _pending.Token);
            switch (result)
            {
                case EnrollmentResult.Enrolled ok:
                    Outcome = new EnrollmentOutcome(target!, ok, name);
                    DialogResult = DialogResult.OK;
                    Close();
                    return;
                case EnrollmentResult.Failed failed:
                    _status.Text = failed.Message;
                    break;
            }
        }
        catch (OperationCanceledException)
        {
            return; // window closing
        }
        finally
        {
            _pending.Dispose();
            _pending = null;
        }
        SetBusy(false);
    }

    private void SetBusy(bool busy)
    {
        _link.Enabled = _code.Enabled = _name.Enabled = _enroll.Enabled = !busy;
        _enroll.Text = busy ? "Enrolling..." : "Enroll";
        UseWaitCursor = busy;
    }
}
