using System.Security.Cryptography;
using Utf8 = System.Text.Encoding;
using DeskBridge.Agent.Core.Relay;

namespace DeskBridge.Agent.Windows.Host;

/// <summary>
/// Stores the per-host secret in a file encrypted with DPAPI for the current Windows user, so another user
/// (or a copy of the file on another machine) cannot read it. Never stored in plain text.
/// </summary>
public sealed class DpapiHostSecretStore : IHostSecretStore
{
    // Binds the ciphertext to this purpose; a DPAPI blob from another app will not decrypt as a host secret.
    private static readonly byte[] Entropy = Utf8.UTF8.GetBytes("DeskBridge.Agent.HostSecret.v1");

    private readonly string _path;

    public DpapiHostSecretStore(string path) => _path = path;

    public string? Load()
    {
        try
        {
            if (!File.Exists(_path)) return null;
            byte[] plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), Entropy, DataProtectionScope.CurrentUser);
            return Utf8.UTF8.GetString(plain);
        }
        catch (CryptographicException)
        {
            // Unreadable (other user, corrupted): behave as not enrolled; the relay decides.
            return null;
        }
    }

    public void Save(string secret)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        byte[] blob = ProtectedData.Protect(Utf8.UTF8.GetBytes(secret), Entropy, DataProtectionScope.CurrentUser);
        string tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, blob);
        File.Move(tmp, _path, overwrite: true);
    }

    public void Clear()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }

    public override string ToString() => nameof(DpapiHostSecretStore);
}
