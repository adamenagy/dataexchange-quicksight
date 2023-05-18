const APS = require('forge-apis');
const { 
  APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL, APS_DATA_ENDPOINT, 
  INTERNAL_TOKEN_SCOPES, PUBLIC_TOKEN_SCOPES,
  DB_HOST, DB_NAME, DB_USER_NAME, DB_USER_PASSWORD,
  AWS_ACCOUNT_ID, AWS_USER_NAME
} = require('../config.js');
//const { get } = require('../routes/auth.js');

const internalAuthClient = new APS.AuthClientThreeLegged(APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL, INTERNAL_TOKEN_SCOPES);
const publicAuthClient = new APS.AuthClientThreeLegged(APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL, PUBLIC_TOKEN_SCOPES);

const service = module.exports = {};

service.getAuthorizationUrl = () => internalAuthClient.generateAuthUrl();

service.authCallbackMiddleware = async (req, res, next) => {
    const internalCredentials = await internalAuthClient.getToken(req.query.code);
    const publicCredentials = await publicAuthClient.refreshToken(internalCredentials);
    req.session.public_token = publicCredentials.access_token;
    req.session.internal_token = internalCredentials.access_token;
    req.session.refresh_token = publicCredentials.refresh_token;
    req.session.expires_at = Date.now() + internalCredentials.expires_in * 1000;
    next();
};

service.authRefreshMiddleware = async (req, res, next) => {
    const { refresh_token, expires_at } = req.session;
    if (!refresh_token) {
        res.status(401).end();
        return;
    }

    if (expires_at < Date.now()) {
        const internalCredentials = await internalAuthClient.refreshToken({ refresh_token });
        const publicCredentials = await publicAuthClient.refreshToken(internalCredentials);
        req.session.public_token = publicCredentials.access_token;
        req.session.internal_token = internalCredentials.access_token;
        req.session.refresh_token = publicCredentials.refresh_token;
        req.session.expires_at = Date.now() + internalCredentials.expires_in * 1000;
    }
    req.internalOAuthToken = {
        access_token: req.session.internal_token,
        expires_in: Math.round((req.session.expires_at - Date.now()) / 1000)
    };
    req.publicOAuthToken = {
        access_token: req.session.public_token,
        expires_in: Math.round((req.session.expires_at - Date.now()) / 1000)
    };
    next();
};

service.getUserProfile = async (token) => {
    const resp = await new APS.UserProfileApi().getUserProfile(internalAuthClient, token);
    return resp.body;
};

service.getHubs = async (token) => {
    const resp = await new APS.HubsApi().getHubs(null, internalAuthClient, token);
    return resp.body.data;
};

service.getProjects = async (hubId, token) => {
    const resp = await new APS.ProjectsApi().getHubProjects(hubId, null, internalAuthClient, token);
    return resp.body.data;
};

service.getProjectContents = async (hubId, projectId, folderId, token) => {
    if (!folderId) {
        const resp = await new APS.ProjectsApi().getProjectTopFolders(hubId, projectId, internalAuthClient, token);
        return resp.body.data;
    } else {
        const resp = await new APS.FoldersApi().getFolderContents(projectId, folderId, null, internalAuthClient, token);
        return resp.body.data;
    }
};

service.getItemVersions = async (projectId, itemId, token) => {
    const resp = await new APS.ItemsApi().getItemVersions(projectId, itemId, null, internalAuthClient, token);
    return resp.body.data;
};

async function createTable(propNames, flattenedJson, tableName) {
  const mysql = require('mysql');

  let con = mysql.createConnection({
    host: DB_HOST,
    user: DB_USER_NAME,
    password: DB_USER_PASSWORD,
    database: DB_NAME
  });

  con.connect(async function(err) {
    if (err) throw err;
    console.log("Connected!");

    //const fs = require('fs');
    //let json = JSON.parse(fs.readFileSync("./wwwroot/test/dx_response.json", 'utf8'));
    //let { propNames, flattenedJson } = flattenJson(json);

    let counter = 0;
    let fields = Object.keys(propNames).map((name) => {
      if (counter++ > 100) return;  
      let type = propNames[name] === 'number' ? 'DOUBLE' : 'VARCHAR(100)';
      return `${name} ${type}`;
    }).filter(name => name !== undefined).join(", ");

    if (fields.length === 0) {
      console.log("No fields to create");
      return;
    }

    tableName = con.escapeId(tableName);
    var sql = `CREATE TABLE ${tableName} (${fields})`;
    //tableName = con.escapeId(tableName);
    //var sql = `CREATE TABLE ${tableName} (ID DOUBLE)`;
    con.query(sql, function (err) {
      if (err) throw err;
      console.log("Table created");
      for (item of flattenedJson) {
        let columns = Object.keys(item).join(", ");
        let values = Object.values(item).map(item => (typeof item === 'number') ? `${item}` : `'${item}'`).join(", ");
        var sql = `INSERT INTO ${tableName} (${columns}) VALUES (${values})`;
        con.query(sql, function (err) {
          if (err) {
            console.log(err.sql);
            throw err;
          }
          console.log("1 record inserted");
        });
      }
    });
  });
}

async function getExchangeData(exchangeId, token) {
  const axios = require('axios');

  const query = ` 
    query DesignEntities($exchangeId: ID!) {
      designEntities(
        filter: { exchangeId: $exchangeId
        }
      ) {
          results {
            id
            name
            classification {
              category
            }
            propertyGroups {
            results {
              id
              name
              properties {
                results {
                  name
                  displayValue
                  value
              propertyDefinition {
                  description
                  specification
                  type
                  units
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const variables = {
    exchangeId
  }

  let response = await axios({
    method: 'POST',
    url: APS_DATA_ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token.access_token}`
    },
    data: { 
      query,
      variables
    }
  })

  console.log(response);

  return response.data;
}

function flattenJson(json) {
  function flattenObject(obj, propGroup, props) {
    if (obj.id !== undefined && obj.properties !== undefined) {
      propGroup = obj.name;
    }
    if (obj.displayValue !== undefined && obj.propertyDefinition !== undefined) {
      let name = `${propGroup}_${obj.name}`.replace(/[\s-]/g, "_");
      props[name] = obj.value;
      if (!propNames[name]) {
        propNames[name] = typeof obj.value; 
      } 
    } else {
      for (let prop in obj) {
        if (obj.hasOwnProperty(prop)) {
          if (typeof obj[prop] === "object") {
            flattenObject(obj[prop], propGroup, props);
          }
        }
      }
    }
  }

  let propNames = {};
  let flattenedJson = json.data.designEntities.results.map((item) => {
    let props = {};
    flattenObject(item, null, props);
    return props;
  });
  console.log(propNames);
  console.log(flattenedJson);

  return { propNames, flattenedJson };
}

service.getExchangeId = async (exchangeFileVersion, token) => {
  const axios = require('axios');

  const query = ` 
    query GetExchnageId($exchangeFileVersion: ID!) {
      exchanges(filter: {exchangeFileVersion: $exchangeFileVersion}) {
        results {
          name
          id
        }
      }
    }
  `;
  const variables = {
    exchangeFileVersion
  }

  let response = await axios({
    method: 'POST',
    url: APS_DATA_ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token.access_token}`
    },
    data: { 
      query,
      variables
    }
  })

  console.log(response); 
  
  return response.data.data.exchanges.results[0].id;
}

service.createQuickSightDataset = async (exchangeId, exchangeName, token) => {
    const data = await getExchangeData(exchangeId, token);
    const flatJson = flattenJson(data);
    await createTable(flatJson.propNames, flatJson.flattenedJson, exchangeName);

    const l = "";
}

service.createQuickSightTest = async (token) => {  
  const { QuickSightClient, CreateDataSourceCommand, CreateDataSetCommand } = require('@aws-sdk/client-quicksight');
  
  const client = new QuickSightClient({ region: 'us-east-1' });

  



  const dataSourceInput = { // CreateDataSourceRequest
    AwsAccountId: AWS_ACCOUNT_ID, // required
    DataSourceId: "mydatasourceId3", // required
    Name: "mydatasourceName3", // required
    Type: "MYSQL", // required
    DataSourceParameters: { // DataSourceParameters Union: only one key present
      MySqlParameters: { // MySqlParameters
        Host: DB_HOST, // required
        Port: 3306, // required
        Database: DB_NAME, // required
      },
    },
    Credentials: { // DataSourceCredentials
      CredentialPair: { // CredentialPair
        Username: DB_USER_NAME, // required
        Password: DB_USER_PASSWORD, // required
        // AlternateDataSourceParameters: [ // DataSourceParametersList
        //   {//  Union: only one key present
        //     MySqlParameters: {
        //       Host: DB_HOST, // required
        //       Port: 3306, // required
        //       Database: DB_NAME, // required
        //     },
        //   },
        // ],
      },
//      CopySourceArn: "STRING_VALUE",
//      SecretArn: "STRING_VALUE",
    },
      Permissions: [ // ResourcePermissionList
        { // ResourcePermission
          Principal: `arn:aws:quicksight:us-east-1:${AWS_ACCOUNT_ID}:user/default/${AWS_USER_NAME}`, // required
          Actions: [ // ActionList // required
            "quicksight:DescribeDataSource",
            "quicksight:DescribeDataSourcePermissions",
            "quicksight:PassDataSource",
            "quicksight:UpdateDataSource",
            "quicksight:DeleteDataSource",
            "quicksight:UpdateDataSourcePermissions",
           // "quicksight:DescribeIngestion",
           // "quicksight:ListIngestions",
           // "quicksight:CreateIngestion",
           // "quicksight:CancelIngestion",
          ],
        },
      ],
//    VpcConnectionProperties: { // VpcConnectionProperties
//      VpcConnectionArn: "STRING_VALUE", // required
//    },
    SslProperties: { // SslProperties
      DisableSsl: true,
    },
    Tags: [ // TagList
      { // Tag
        Key: "Key", // required
        Value: "Value", // required
      },
    ],
  };  

  const dataSourceCommand = new CreateDataSourceCommand(dataSourceInput);
  const dataSourceResponse = await client.send(dataSourceCommand);
  

 

/*

  const dataSetInput = { // CreateDataSetRequest
  AwsAccountId: AWS_ACCOUNT_ID, // required
  DataSetId: "mydatasetId4", // required
  Name: "mydatasetName4", // required
  PhysicalTableMap: { // PhysicalTableMap // required
    "12012023-sdfds1111111111": { // PhysicalTable Union: only one key present
      RelationalTable: { // RelationalTable
        DataSourceArn: `arn:aws:quicksight:us-east-1:${AWS_ACCOUNT_ID}:datasource/mydatasource2`, // required
        Name: "12012023-sdfds1111111111", // required
        InputColumns: [ // InputColumnList // required
          { // InputColumn
            Name: "base_name", // required
            Type: "STRING", // required
          },
        ],
      },
      
    },
  },

  ImportMode: "DIRECT_QUERY", // required
 // https://docs.aws.amazon.com/solutions/latest/devops-monitoring-dashboard-on-aws/retrieve-the-amazon-quicksight-principal-arn.html
  Permissions: [ // ResourcePermissionList
      { // ResourcePermission
        Principal: `arn:aws:quicksight:us-east-1:${AWS_ACCOUNT_ID}:user/default/${AWS_USER_NAME}`, // required
        Actions: [ // ActionList // required
          "quicksight:DescribeDataSet",
          "quicksight:DescribeDataSetPermissions",
          "quicksight:PassDataSet",
          "quicksight:DescribeIngestion",
          "quicksight:ListIngestions",
          "quicksight:UpdateDataSet",
          "quicksight:DeleteDataSet",
          "quicksight:CreateIngestion",
          "quicksight:CancelIngestion",
          "quicksight:UpdateDataSetPermissions"
        ],
      },
    ],
  
};
const dataSetCommand = new CreateDataSetCommand(dataSetInput);
const dataSetResponse = await client.send(dataSetCommand);
*/
}


