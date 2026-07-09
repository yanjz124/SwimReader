using System;
using System.Media;
using System.Reflection;

namespace DGScope
{
    /// <summary>
    /// Plays the CRC alert sounds (MSAW, MCI, Conflict Alert). The clips are a
    /// single cycle, so they are played with PlayLooping and stopped when the
    /// alert clears. Each sound tracks its own playing state so callers can poke
    /// the desired state every frame without restarting the loop.
    /// </summary>
    public class StarsSounds : IDisposable
    {
        private readonly SoundPlayer msaw;
        private readonly SoundPlayer mci;
        private readonly SoundPlayer conflictAlert;
        private readonly SoundPlayer specialCode;
        private bool msawPlaying, mciPlaying, caPlaying, spcPlaying;
        private readonly object sync = new object();

        public StarsSounds()
        {
            msaw = Load("DGScope.Sounds.Msaw.wav");
            mci = Load("DGScope.Sounds.Mci.wav");
            conflictAlert = Load("DGScope.Sounds.ConflictAlert.wav");
            specialCode = Load("DGScope.Sounds.SpecialCode.wav");
        }

        private static SoundPlayer Load(string resourceName)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName);
            if (stream == null)
                return null;
            var player = new SoundPlayer(stream);
            try { player.Load(); } catch { /* ignore unloadable clip */ }
            return player;
        }

        public void SetMsaw(bool active) => Set(msaw, active, ref msawPlaying);
        public void SetMci(bool active) => Set(mci, active, ref mciPlaying);
        public void SetConflictAlert(bool active) => Set(conflictAlert, active, ref caPlaying);
        public void SetSpecialCode(bool active) => Set(specialCode, active, ref spcPlaying);

        private void Set(SoundPlayer player, bool active, ref bool playing)
        {
            if (player == null)
                return;
            lock (sync)
            {
                if (active && !playing)
                {
                    try { player.PlayLooping(); } catch { }
                    playing = true;
                }
                else if (!active && playing)
                {
                    try { player.Stop(); } catch { }
                    playing = false;
                }
            }
        }

        public void Dispose()
        {
            msaw?.Dispose();
            mci?.Dispose();
            conflictAlert?.Dispose();
            specialCode?.Dispose();
        }
    }
}
