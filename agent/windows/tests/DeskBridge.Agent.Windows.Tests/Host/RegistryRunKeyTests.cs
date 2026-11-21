using DeskBridge.Agent.Windows.Host;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Host;

public sealed class RegistryRunKeyTests
{
    [Fact]
    public void Set_get_delete_round_trip_in_the_current_user_run_key()
    {
        // A unique value name, removed in finally, so a failed run leaves no stray startup entry behind.
        string name = "DeskBridge.Tests." + Guid.NewGuid().ToString("N");
        var key = new RegistryRunKey();
        try
        {
            Assert.Null(key.Get(name));

            key.Set(name, @"""C:\nowhere\test.exe""");
            Assert.Equal(@"""C:\nowhere\test.exe""", key.Get(name));

            key.Delete(name);
            Assert.Null(key.Get(name));
            key.Delete(name);
        }
        finally
        {
            key.Delete(name);
        }
    }
}
