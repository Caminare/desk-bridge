using DeskBridge.Agent.Core.Input;
using DeskBridge.Agent.Windows.Input;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Input;

public class InputCoalescerTests
{
    private static List<InputCommand> Fold(params InputCommand[] commands)
    {
        var pending = new List<InputCommand>();
        foreach (InputCommand command in commands)
        {
            InputCoalescer.Add(pending, command);
        }
        return pending;
    }

    [Fact]
    public void Consecutive_relative_moves_are_summed()
    {
        Assert.Equal(
            new InputCommand[] { new MouseMoveRelative(4, -3) },
            Fold(new MouseMoveRelative(1, 2), new MouseMoveRelative(3, -5)));
    }

    [Fact]
    public void Consecutive_absolute_moves_keep_only_the_latest()
    {
        Assert.Equal(
            new InputCommand[] { new MouseMoveAbsolute(0.5, 0.6) },
            Fold(new MouseMoveAbsolute(0.1, 0.1), new MouseMoveAbsolute(0.5, 0.6)));
    }

    [Fact]
    public void Relative_and_absolute_moves_are_not_merged_with_each_other()
    {
        InputCommand[] result = Fold(new MouseMoveRelative(1, 1), new MouseMoveAbsolute(0.2, 0.2)).ToArray();

        Assert.Equal(new InputCommand[] { new MouseMoveRelative(1, 1), new MouseMoveAbsolute(0.2, 0.2) }, result);
    }

    [Fact]
    public void A_click_between_moves_separates_them()
    {
        var click = new MouseClick(MouseButton.Right, false, null);

        Assert.Equal(
            new InputCommand[] { new MouseMoveRelative(1, 0), click, new MouseMoveRelative(1, 0) },
            Fold(new MouseMoveRelative(1, 0), click, new MouseMoveRelative(1, 0)));
    }

    [Fact]
    public void Summed_deltas_saturate_instead_of_overflowing()
    {
        Assert.Equal(
            new InputCommand[] { new MouseMoveRelative(int.MaxValue, 0) },
            Fold(new MouseMoveRelative(int.MaxValue - 1, 0), new MouseMoveRelative(10, 0)));
    }
}
