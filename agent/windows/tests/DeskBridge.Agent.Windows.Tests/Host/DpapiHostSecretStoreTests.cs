using DeskBridge.Agent.Windows.Host;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Host;

public sealed class DpapiHostSecretStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "deskbridge-tests-" + Guid.NewGuid().ToString("N"));
    private string SecretPath => Path.Combine(_dir, "host-secret.bin");

    [Fact]
    public void Missing_file_means_not_enrolled()
    {
        Assert.Null(new DpapiHostSecretStore(SecretPath).Load());
    }

    [Fact]
    public void Saved_secret_round_trips_and_is_not_stored_in_plain_text()
    {
        new DpapiHostSecretStore(SecretPath).Save("s3cret-value-123");

        Assert.Equal("s3cret-value-123", new DpapiHostSecretStore(SecretPath).Load());
        string raw = System.Text.Encoding.Latin1.GetString(File.ReadAllBytes(SecretPath));
        Assert.DoesNotContain("s3cret-value-123", raw);
    }

    [Fact]
    public void Corrupted_file_is_treated_as_not_enrolled()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllBytes(SecretPath, [1, 2, 3, 4]);

        Assert.Null(new DpapiHostSecretStore(SecretPath).Load());
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }
}
