using DeskBridge.Agent.Core.Input;

namespace DeskBridge.Agent.Windows.Input;

/// <summary>
/// Merges queued moves so a backlog of pointer events costs one SendInput call. Only the last
/// pending entry merges with the next command, so ordering against clicks, keys and text is kept.
/// </summary>
public static class InputCoalescer
{
    /// <summary>
    /// Appends <paramref name="command"/> to <paramref name="pending"/>. Consecutive relative moves
    /// are summed. Consecutive absolute moves keep only the latest position.
    /// </summary>
    public static void Add(List<InputCommand> pending, InputCommand command)
    {
        if (pending.Count > 0)
        {
            switch (pending[^1], command)
            {
                case (MouseMoveRelative last, MouseMoveRelative next):
                    pending[^1] = new MouseMoveRelative(Sum(last.Dx, next.Dx), Sum(last.Dy, next.Dy));
                    return;
                case (MouseMoveAbsolute, MouseMoveAbsolute next):
                    pending[^1] = next;
                    return;
            }
        }
        pending.Add(command);
    }

    private static int Sum(int a, int b) => (int)Math.Clamp((long)a + b, int.MinValue, int.MaxValue);
}
