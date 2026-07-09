using System;
using System.Windows.Forms;

namespace DGScope.ADSBBeaconReader
{
    public partial class ADSBBeaconReaderForm : Form
    {
        private readonly ADSBBeaconReaderSettings settings;
        private readonly ADSBBeaconReaderService service;

        public ADSBBeaconReaderForm(ADSBBeaconReaderSettings settings, ADSBBeaconReaderService service = null)
        {
            InitializeComponent();
            this.settings = settings;
            this.service = service;
            this.KeyDown += ADSBBeaconReaderForm_KeyDown;
            this.KeyPreview = true;
            LoadSettings();
        }

        private void ADSBBeaconReaderForm_KeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.B && e.Control)
                this.Close();
            if (e.KeyCode == Keys.Escape)
                this.Close();
        }

        private void LoadSettings()
        {
            chkHideLADD.Checked = settings.HideLADDCallsigns;
            numPollInterval.Value = Math.Max(3, Math.Min(300, settings.PollIntervalSeconds));

            checkedListBoxSources.Items.Clear();
            foreach (var source in settings.Sources)
                checkedListBoxSources.Items.Add(source, source.Enabled);

            checkedListBoxSources.ItemCheck += CheckedListBoxSources_ItemCheck;
        }

        private void CheckedListBoxSources_ItemCheck(object sender, ItemCheckEventArgs e)
        {
            settings.Sources[e.Index].Enabled = e.NewValue == CheckState.Checked;
        }

        private void chkHideLADD_CheckedChanged(object sender, EventArgs e)
        {
            settings.HideLADDCallsigns = chkHideLADD.Checked;
            service?.ClearCallsignCache();
        }

        private void numPollInterval_ValueChanged(object sender, EventArgs e)
        {
            settings.PollIntervalSeconds = (int)numPollInterval.Value;
        }

        private void btnAddSource_Click(object sender, EventArgs e)
        {
            string name = "";
            if (Input.InputBox("Add ADS-B Source", "Source Name:", ref name) != System.Windows.Forms.DialogResult.OK
                || string.IsNullOrWhiteSpace(name))
                return;

            string url = "";
            if (Input.InputBox("Add ADS-B Source", "Base URL (e.g. https://api.example.com/v2):", ref url) != System.Windows.Forms.DialogResult.OK
                || string.IsNullOrWhiteSpace(url))
                return;

            var source = new ADSBSource
            {
                Name = name.Trim(),
                BaseUrl = url.Trim(),
                Enabled = true,
                IsBuiltIn = false
            };

            settings.Sources.Add(source);
            checkedListBoxSources.Items.Add(source, source.Enabled);
        }

        private void btnRemoveSource_Click(object sender, EventArgs e)
        {
            int index = checkedListBoxSources.SelectedIndex;
            if (index < 0)
                return;

            var source = settings.Sources[index];
            if (source.IsBuiltIn)
            {
                MessageBox.Show("Built-in sources cannot be removed.", "ADS-B Beacon Reader",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            settings.Sources.RemoveAt(index);
            checkedListBoxSources.Items.RemoveAt(index);
        }
    }
}
