const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');

// Allows us to access the .env
require('dotenv').config();

const app = express();
const port = process.env.PORT; // default port to listen

const corsOptions = {
   origin: '*', 
   credentials: true,  // access-control-allow-credentials:true
   optionSuccessStatus: 200,
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

app.use(cors(corsOptions));

// Makes Express parse the JSON body of any requests and adds the body to the req object
app.use(bodyParser.json());

app.use(async (req, res, next) => {
  try {
    // Connecting to our SQL db. req gets modified and is available down the line in other middleware and endpoint functions
    req.db = await pool.getConnection();
    req.db.connection.config.namedPlaceholders = true;

    // Traditional mode ensures not null is respected for unsupplied fields, ensures valid JavaScript dates, etc.
    await req.db.query('SET SESSION sql_mode = "TRADITIONAL"');
    await req.db.query(`SET time_zone = '-8:00'`);

    // Moves the request on down the line to the n ext middleware functions and/or the endpoint it's headed for
    await next();

    // After the endpoint has been reached and resolved, disconnects from the database
    req.db.release();
  } catch (err) {
    // If anything downstream throw an error, we must release the connection allocated for the request
    console.log(err)
    // If an error occurs, disconnects from the database
    if (req.db) req.db.release();
    throw err;
  }
});

// Creates a GET endpoint at <WHATEVER_THE_BASE_URL_IS>
app.get('/', (req, res) => {

  // Attaches JSON content to the response
  res.json('Hi');
});

// Returns all the cars in the database
app.get('/cars',async (req,res)=>{
  try{
    const query = await req.db.query(
      `SELECT * FROM car
      WHERE car.deleted_flag = 0;`
    )
    res.json({success: true, message: query[0], data: null})
  }
  catch (err){
    res.json({success: false, message: err, data: null})
  }
});

// Adds a car to the database based on request body
app.post('/cars', async (req, res) => {
  try{
    const {make,model,year} = req.body;
    const query = await req.db.query(
      `INSERT INTO car (make, model, year)
      VALUES (:make,:model,:year);`,
      {
        make,model,year
      }
    )
    res.json({success: true, message: query[0], data: null})
  }
  catch (err){
    res.json({success: false, message: err, data: null})
  }
});

// Updates a car in the database based on the id from the URL
app.put('/cars/:id', async (req, res) => {
  try{
    const {make,model,year} = req.body;
    const {id} = req.params
    const query = await req.db.query(
      `UPDATE car
      SET make = :make , model = :model , year = :year
      WHERE car.id = :id`,
      {
        make,model,year,id
      }
    )
    res.json({success: true, message: query[0], data: null})
  }
  catch (err){
    res.json({success: false, message: err, data: null})
  }
});

//Deletes a car in the database based on the id from the URL, by setting its deleted flag to true(so it can be recovered later if needed)
app.delete('/cars/:id', async (req, res) => {
  try{
    const {id} = req.params
    const query = await req.db.query(
      `UPDATE car
      SET deleted_flag = 1
      WHERE car.id = :id`,
      {
        id
      }
    )
    res.json({success: true, message: query[0], data: null})
  }
  catch (err){
    res.json({success: false, message: err, data: null})
  }
});


app.post('/register', async function (req, res) {
  try {
    let encodedUser;

    // Hashes the password and inserts the info into the `user` table
    await bcrypt.hash(req.body.password, 10).then(async hash => {
      try {
        console.log('HASHED PASSWORD', hash);

        const [user] = await req.db.query(`
          INSERT INTO user (user_name, password)
          VALUES (:username, :password);
        `, {
          username: req.body.username,
          password: hash
        });

        console.log('USER', user)

        encodedUser = jwt.sign(
          { 
            userId: user.insertId,
            ...req.body
          },
          process.env.JWT_KEY
        );

        console.log('ENCODED USER', encodedUser);
      } catch (error) {
        console.log('error', error);
      }
    });

    res.json({ jwt: encodedUser });
  } catch (err) {
    console.log('err', err);
    res.json({ err });
  }
});

app.post('/authenticate', async function (req, res) {
  try {
    console.log('ONE')
    const { username, password } = req.body;
    const [[user]] = await req.db.query(`SELECT * FROM user WHERE user_name = :username`, {  username });

    if (!user) res.json('Email not found');
    const dbPassword = `${user.password}`
    const compare = await bcrypt.compare(password, dbPassword);

    if (compare) {
      const payload = {
        userId: user.id,
        username: user.username,
      }
      
      const encodedUser = jwt.sign(payload, process.env.JWT_KEY);

      res.json({ jwt: encodedUser });
    } else {
      res.json('Password not found');
    }
    
  } catch (err) {
    console.log('Error in /authenticate', err)
  }
});

// Jwt verification checks to see if there is an authorization header with a valid jwt in it.
app.use(async function verifyJwt(req, res, next) {
  if (!req.headers.authorization) {
    res.json('Invalid authorization, no authorization headers');
  }

  const [scheme, token] = req.headers.authorization.split(' ');

  if (scheme !== 'Bearer') {
    res.json('Invalid authorization, invalid authorization scheme');
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_KEY);
    req.user = payload;
  } catch (err) {
    console.log(err);
    if (
      err.message && 
      (err.message.toUpperCase() === 'INVALID TOKEN' || 
      err.message.toUpperCase() === 'JWT EXPIRED')
    ) {

      req.status = err.status || 500;
      req.body = err.message;
      req.app.emit('jwt-error', err, req);
    } else {

      throw((err.status || 500), err.message);
    }
  }

  await next();
});

// GET request to http://localhost:8080/last-messages ends here
app.get('/last-messages', async (req, res) => {
    try {

      const [lastMessages] = await req.db.query(`
      SELECT messages.* FROM messages,  
      (
        SELECT from_user_id, max(date_time) AS date_time FROM messages GROUP BY from_user_id
      ) last_message 
      WHERE messages.from_user_id = last_message.from_user_id 
      AND messages.date_time = last_message.date_time`);
    
        res.json({ lastMessages });
    } catch (err) {
      console.log(err);
      res.json({ err });
    }
});

// Start the Express server
app.listen(port, () => {
  console.log(`server started at http://localhost:${port}`);
});
