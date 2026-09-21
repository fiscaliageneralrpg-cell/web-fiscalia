const express = require('express');
const path = require('path');
const { probarConexion } = require('./db');

require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/estado', async (req, res) => {
    res.json({
        correcto: true,
        mensaje: 'La web está funcionando'
    });
});

probarConexion().catch((error) => {
    console.error('❌ Error conectando a MySQL:', error.message);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web iniciada en el puerto ${PORT}`);
});
