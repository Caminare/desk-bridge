using DeskBridge.Agent.Core.Input;

namespace DeskBridge.Agent.Windows.Input;

/// <summary>Applies one input command to the desktop. Implementations are called from a single thread.</summary>
public interface IInputInjector
{
    void Inject(InputCommand command);
}
