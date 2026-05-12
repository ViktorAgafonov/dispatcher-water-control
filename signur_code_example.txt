using System.Net.Sockets;

namespace EhoMon
{
    public partial class Form1 : Form
    {
        private readonly System.Windows.Forms.Timer timer;
        private bool isConnected = false;

        private string ip_1 = "127.0.0.1";
        private int port_1 = 502;
        private string ip_2 = "127.0.0.1";
        private int port_2 = 503;

        public Form1()
        {
            InitializeComponent();
            checkBox1.CheckedChanged += CheckBox_CheckedChanged;
            checkBox2.CheckedChanged += CheckBox_CheckedChanged;

            timer = new System.Windows.Forms.Timer { Interval = 1000 };
            timer.Tick += Timer_Tick;
        }

        private void CheckBox_CheckedChanged(object sender, EventArgs e)
        {
            isConnected = checkBox1.Checked || checkBox2.Checked;
            if (isConnected) timer.Start();
            else
                timer.Stop();
        }

        private async void Timer_Tick(object sender, EventArgs e)
        {
            if (isConnected)
            {
                if (checkBox1.Checked)
                {
                    try
                    {
                        var data = await RemoteClient.SendRequestAsync(ip_1, port_1);
                        this.UpdateFormLeft(DataDecoder.Decode(data));
                    }
                    catch (Exception ex)
                    {
                        isConnected = false;
                        checkBox1.Checked = false;
                        MessageBox.Show(ex.Message);
                    }
                }

                if (checkBox2.Checked)
                {
                    try
                    {
                        var data = await RemoteClient.SendRequestAsync(ip_2, port_2);
                        UpdateFormRight(DataDecoder.Decode(data));
                    }
                    catch (Exception ex)
                    {
                        isConnected = false;
                        checkBox2.Checked = false;
                        MessageBox.Show(ex.Message);
                    }
                }

            }
        }

        private void UpdateFormLeft(DecodedData data)
        {
            txt_level1.Text = data.H.ToString("F1");
            txt_rate1.Text = (data.Q * 3600).ToString("F1");
            txt_value1.Text = (data.U * data.PU).ToString("F1");
            txt_date1.Text = Convert.ToString($"{data.Date:00}.{data.Month:00}.{data.Year:00}");
            txt_time1.Text = Convert.ToString($"{data.Hour:00}:{data.Minute:00}:{data.Second:00}");
            txt_sernum1.Text = Convert.ToString(data.SerialNumber);
        }
        private void UpdateFormRight(DecodedData data)
        {
            txt_level2.Text = data.H.ToString("F1");
            txt_rate2.Text = (data.Q * 3600).ToString("F1");
            txt_value2.Text = (data.U * data.PU).ToString("F1");
            txt_date2.Text = Convert.ToString($"{data.Date:00}.{data.Month:00}.{data.Year:00}");
            txt_time2.Text = Convert.ToString($"{data.Hour:00}:{data.Minute:00}:{data.Second:00}");
            txt_sernum2.Text = Convert.ToString(data.SerialNumber);
        }
    }

    public static class RemoteClient
    {
        public static async Task<byte[]> SendRequestAsync(string ip, int port)
        {
            using (var client = new TcpClient())
            {
                await client.ConnectAsync(ip, port); var stream = client.GetStream();
                await stream.WriteAsync([0x01, 0x03, 0x00, 0x01, 0x00, 0x0F, 0x54, 0x0E], 0, 8);
                var responseData = new byte[37];

                await stream.ReadAsync(responseData);
                //await stream.ReadAsync(responseData, 0, responseData.Length);

                return responseData; 
            }
        }
    }

    public static class DataDecoder
    {
        public static DecodedData Decode(byte[] data)
        {
            return new DecodedData
            {
                H = BitConverter.ToSingle(data, 2),
                Q = BitConverter.ToSingle(data, 6),
                U = BitConverter.ToInt32(data, 10),
                AccTime = BitConverter.ToInt32(data, 15), // work times, not use this app
                PU = (double) Math.Pow(10, (BitConverter.ToInt16(data, 21) - 3)),
                Minute = (byte) (10 * (data[24] / 16) + (data[24] % 16)),
                Second = (byte) (10 * (data[23] / 16) + (data[23] % 16)),
                Hour = (byte) (10 * (data[25] / 16) + (data[25] % 16)),
                Date = (byte) (10 * (data[27] / 16) + (data[27] % 16)),
                Month = (byte) (10 * (data[28] / 16) + (data[28] % 16)),
                Year = 10 * (data[29] / 16) + (data[29] % 16),
                SerialNumber = BitConverter.ToInt16(data, 31),
            };
}
    }

    public class DecodedData
{
    public float H { get; set; }
    public float Q { get; set; }
    public int U { get; set; }
    public int AccTime { get; set; }
    public double PU { get; set; }
    public byte Minute { get; set; }
    public byte Second { get; set; }
    public byte Hour { get; set; }
    public byte Month { get; set; }
    public byte Date { get; set; }
    public int Year { get; set; }
    public short SerialNumber { get; set; }
}
}
