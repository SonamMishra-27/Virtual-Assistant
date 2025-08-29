# 🎤 Virtual Assistant 

A real-time **speech-to-text + AI assistant + text-to-speech** web app, powered by **AssemblyAI**, **Google Gemini**, **Murf**, **Tavily**, and **OpenWeather**.  
Built with **FastAPI + WebSockets + Vanilla JS + Tailwind-inspired CSS**.  

Users provide their **own API keys** through the UI (no `.env` required).  
This makes deployment on **Render** (or any hosting service) safe and easy.

---

## ✨ Features

- 🎙 **Live Transcription** (AssemblyAI WebSocket API)  
- 🤖 **AI Responses** (Google Gemini)  
- 🔊 **Voice Playback** (Murf TTS)  
- 🌍 **Web Search** (Tavily)  
- ⛅ **Weather Widget** (OpenWeather API)  
- 🟣 Sleek **Solo Leveling inspired UI** with glowing effects  

---

## 🛠 Tech Stack

- **Backend**: FastAPI + Uvicorn  
- **Frontend**: HTML, CSS, JavaScript  
- **APIs Used**:  
  - AssemblyAI (speech-to-text)  
  - Google Gemini (AI responses)  
  - Murf (text-to-speech)  
  - Tavily (web search)  
  - OpenWeather (weather data)  

---

## 🚀 Deployment on Render

1. Fork this repo & push to your GitHub  
2. On [Render](https://render.com):
   - Create a **New Web Service**
   - Connect your GitHub repo
   - Set:
     - **Build Command**:  
       ```bash
       pip install -r requirements.txt
       ```
     - **Start Command**:  
       ```bash
       uvicorn main:app --host 0.0.0.0 --port 10000
       ```
   - Choose a free instance (works fine)  
3. Deploy 🚀  

No `.env` required — users will enter their own API keys in the UI.

---

## 🔑 Using Your Own API Keys

When you open the app:  
- Click the **“⚙️ API Settings”** button  
- Enter:
  - `AssemblyAI API Key`
  - `Google API Key`
  - `Murf API Key`
  - `Tavily API Key`
  - `Weather API Key`
- Keys are stored securely in **your browser’s localStorage** (not on the server).

---

## 💻 Local Development

```bash
git clone https://github.com/yourusername/virtual-assistant.git
cd virtual-assistant
pip install -r requirements.txt
uvicorn main:app --reload
````

Then visit:
👉 [http://127.0.0.1:8000](http://127.0.0.1:8000)

---

## 📂 Project Structure

```
├── main.py           # FastAPI backend
├── static/
│   ├── index.html    # UI
│   ├── style.css     # Styles
│   ├── script.js     # Frontend logic
├── requirements.txt  # Python dependencies
└── README.md         # You are here
```


## 🧑‍💻 Author

Built with ❤️ by \[Sonam Mishra ]

---

## 📬 Contact

💡 Got feedback or ideas? Let’s connect!
**GitHub:** (https://github.com/SonamMishra-27/Virtual-Assistant)
**LinkedIn:** \[https://www.linkedin.com/in/sonammishra2706/]


## 📜 License

MIT License – free to use & modify.



