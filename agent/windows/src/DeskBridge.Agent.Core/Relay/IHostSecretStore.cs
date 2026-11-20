namespace DeskBridge.Agent.Core.Relay;

public interface IHostSecretStore
{
    string? Load();
    void Save(string secret);
}

public sealed class InMemoryHostSecretStore : IHostSecretStore
{
    private string? _secret;

    public InMemoryHostSecretStore(string? initial = null) => _secret = initial;

    public string? Load() => _secret;

    public void Save(string secret) => _secret = secret;

    public override string ToString() => nameof(InMemoryHostSecretStore);
}
