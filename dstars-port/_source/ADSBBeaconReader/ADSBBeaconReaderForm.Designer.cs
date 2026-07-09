namespace DGScope.ADSBBeaconReader
{
    partial class ADSBBeaconReaderForm
    {
        private System.ComponentModel.IContainer components = null;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        #region Windows Form Designer generated code

        private void InitializeComponent()
        {
            this.checkedListBoxSources = new System.Windows.Forms.CheckedListBox();
            this.chkHideLADD = new System.Windows.Forms.CheckBox();
            this.lblSources = new System.Windows.Forms.Label();
            this.btnAddSource = new System.Windows.Forms.Button();
            this.btnRemoveSource = new System.Windows.Forms.Button();
            this.lblPollInterval = new System.Windows.Forms.Label();
            this.numPollInterval = new System.Windows.Forms.NumericUpDown();
            this.lblSeconds = new System.Windows.Forms.Label();
            ((System.ComponentModel.ISupportInitialize)(this.numPollInterval)).BeginInit();
            this.SuspendLayout();
            //
            // lblSources
            //
            this.lblSources.AutoSize = true;
            this.lblSources.Location = new System.Drawing.Point(12, 9);
            this.lblSources.Name = "lblSources";
            this.lblSources.Size = new System.Drawing.Size(93, 13);
            this.lblSources.TabIndex = 0;
            this.lblSources.Text = "ADS-B Sources:";
            //
            // checkedListBoxSources
            //
            this.checkedListBoxSources.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left)
            | System.Windows.Forms.AnchorStyles.Right)));
            this.checkedListBoxSources.FormattingEnabled = true;
            this.checkedListBoxSources.Location = new System.Drawing.Point(12, 28);
            this.checkedListBoxSources.Name = "checkedListBoxSources";
            this.checkedListBoxSources.Size = new System.Drawing.Size(310, 124);
            this.checkedListBoxSources.TabIndex = 1;
            //
            // btnAddSource
            //
            this.btnAddSource.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this.btnAddSource.Location = new System.Drawing.Point(328, 28);
            this.btnAddSource.Name = "btnAddSource";
            this.btnAddSource.Size = new System.Drawing.Size(75, 23);
            this.btnAddSource.TabIndex = 2;
            this.btnAddSource.Text = "Add...";
            this.btnAddSource.UseVisualStyleBackColor = true;
            this.btnAddSource.Click += new System.EventHandler(this.btnAddSource_Click);
            //
            // btnRemoveSource
            //
            this.btnRemoveSource.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this.btnRemoveSource.Location = new System.Drawing.Point(328, 57);
            this.btnRemoveSource.Name = "btnRemoveSource";
            this.btnRemoveSource.Size = new System.Drawing.Size(75, 23);
            this.btnRemoveSource.TabIndex = 3;
            this.btnRemoveSource.Text = "Remove";
            this.btnRemoveSource.UseVisualStyleBackColor = true;
            this.btnRemoveSource.Click += new System.EventHandler(this.btnRemoveSource_Click);
            //
            // chkHideLADD
            //
            this.chkHideLADD.AutoSize = true;
            this.chkHideLADD.Location = new System.Drawing.Point(12, 162);
            this.chkHideLADD.Name = "chkHideLADD";
            this.chkHideLADD.Size = new System.Drawing.Size(259, 17);
            this.chkHideLADD.TabIndex = 4;
            this.chkHideLADD.Text = "Hide LADD callsigns (FAA SWIM compliance)";
            this.chkHideLADD.UseVisualStyleBackColor = true;
            this.chkHideLADD.CheckedChanged += new System.EventHandler(this.chkHideLADD_CheckedChanged);
            //
            // lblPollInterval
            //
            this.lblPollInterval.AutoSize = true;
            this.lblPollInterval.Location = new System.Drawing.Point(12, 190);
            this.lblPollInterval.Name = "lblPollInterval";
            this.lblPollInterval.Size = new System.Drawing.Size(70, 13);
            this.lblPollInterval.TabIndex = 5;
            this.lblPollInterval.Text = "Poll interval:";
            //
            // numPollInterval
            //
            this.numPollInterval.Location = new System.Drawing.Point(88, 188);
            this.numPollInterval.Maximum = new decimal(new int[] { 300, 0, 0, 0 });
            this.numPollInterval.Minimum = new decimal(new int[] { 3, 0, 0, 0 });
            this.numPollInterval.Name = "numPollInterval";
            this.numPollInterval.Size = new System.Drawing.Size(55, 20);
            this.numPollInterval.TabIndex = 6;
            this.numPollInterval.Value = new decimal(new int[] { 5, 0, 0, 0 });
            this.numPollInterval.ValueChanged += new System.EventHandler(this.numPollInterval_ValueChanged);
            //
            // lblSeconds
            //
            this.lblSeconds.AutoSize = true;
            this.lblSeconds.Location = new System.Drawing.Point(149, 190);
            this.lblSeconds.Name = "lblSeconds";
            this.lblSeconds.Size = new System.Drawing.Size(47, 13);
            this.lblSeconds.TabIndex = 7;
            this.lblSeconds.Text = "seconds";
            //
            // ADSBBeaconReaderForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(415, 220);
            this.Controls.Add(this.lblSeconds);
            this.Controls.Add(this.numPollInterval);
            this.Controls.Add(this.lblPollInterval);
            this.Controls.Add(this.chkHideLADD);
            this.Controls.Add(this.btnRemoveSource);
            this.Controls.Add(this.btnAddSource);
            this.Controls.Add(this.checkedListBoxSources);
            this.Controls.Add(this.lblSources);
            this.FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.Name = "ADSBBeaconReaderForm";
            this.StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen;
            this.Text = "ADS-B Beacon Reader Settings";
            ((System.ComponentModel.ISupportInitialize)(this.numPollInterval)).EndInit();
            this.ResumeLayout(false);
            this.PerformLayout();
        }

        #endregion

        private System.Windows.Forms.CheckedListBox checkedListBoxSources;
        private System.Windows.Forms.CheckBox chkHideLADD;
        private System.Windows.Forms.Label lblSources;
        private System.Windows.Forms.Button btnAddSource;
        private System.Windows.Forms.Button btnRemoveSource;
        private System.Windows.Forms.Label lblPollInterval;
        private System.Windows.Forms.NumericUpDown numPollInterval;
        private System.Windows.Forms.Label lblSeconds;
    }
}
