using System.Net.WebSockets;
using System.Threading.Channels;

namespace SwimServer;

record WsMsg(string Type, object Data);

class WsClient(WebSocket ws)
{
    public WebSocket Ws { get; } = ws;

    // LADD backdoor: when true this connection receives real (un-masked) identities.
    // Set at connect time from the bypass key on the WS request.
    public bool Reveal { get; set; }
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
