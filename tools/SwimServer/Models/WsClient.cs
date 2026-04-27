using System.Net.WebSockets;
using System.Threading.Channels;

namespace SwimServer;

record WsMsg(string Type, object Data);

class WsClient(WebSocket ws)
{
    public WebSocket Ws { get; } = ws;
    public Channel<byte[]> Queue { get; } = Channel.CreateBounded<byte[]>(
        new BoundedChannelOptions(512)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true
        });

    public void Enqueue(byte[] data)
    {
        Queue.Writer.TryWrite(data);
    }
}
